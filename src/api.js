/**
 * api.js — a small, READ-ONLY HTTP API for the blockchain explorer.
 *
 * Separate from the peer-to-peer TCP protocol: this is for humans (the React
 * dashboard), not for nodes. It can only READ each node's state:
 *
 *   • GET only. No endpoint mines, signs, sends, or changes anything.
 *   • Bound to 127.0.0.1 by default, and requests must use a local Host header
 *     (blocks "DNS rebinding", where a web page tricks your browser into
 *     talking to a local service under a foreign name).
 *   • It is never given wallets, so it cannot leak private keys.
 *   • URL length, page sizes, and request bodies are limited.
 *
 * It can also serve the built frontend (frontend/dist) so one process runs
 * everything.
 */
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import { Transaction } from './transaction.js';
import { chainWork, transactionId } from './consensus.js';
import { isNodeId } from './protocol.js';
import { contractPhase, isValidContractId, isWithdrawal, MAX_CONTRACTS } from './contracts.js';

const MAX_URL_LENGTH = 2048;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const RECENT_BLOCKS = 8;
// Network mempool view: recently confirmed txs per node (so the
// pending → confirmed transition stays visible), and a cap on rows returned.
const RECENT_CONFIRMED_PER_NODE = 10;
const MAX_MEMPOOL_ROWS = 200;
const HEX64 = /^[0-9a-f]{64}$/;
const HEIGHT = /^(0|[1-9][0-9]{0,8})$/;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

/** An error with an HTTP status code, safe to show to the client. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class ExplorerApi {
  #server;
  #nodes; // id → Node
  #labels; // address → display name (e.g. "Alice")
  #staticDir;
  #host;

  /**
   * @param {object} options
   * @param {import('./node.js').Node[]} options.nodes - Nodes to expose (read-only).
   * @param {Record<string,string>} [options.addressLabels] - Optional display names.
   * @param {string} [options.staticDir] - Built frontend to serve, if any.
   * @param {string} [options.host] - Interface to bind. Local-only by default.
   */
  constructor({ nodes, addressLabels = {}, staticDir = null, host = '127.0.0.1' }) {
    this.#nodes = new Map(nodes.map((node) => [node.id, node]));
    this.#labels = { ...addressLabels };
    this.#staticDir = staticDir ? path.resolve(staticDir) : null;
    this.#host = host;
    this.port = null;
    this.#server = http.createServer((req, res) => this.#handle(req, res));
  }

  get url() {
    return `http://${this.#host}:${this.port}`;
  }

  async start(port = 0) {
    this.#server.listen(port, this.#host);
    await once(this.#server, 'listening');
    this.port = this.#server.address().port;
    return this.port;
  }

  async stop() {
    if (!this.#server.listening) return;
    const closed = new Promise((resolve) => this.#server.close(resolve));
    this.#server.closeAllConnections(); // browsers keep connections open
    await closed;
  }

  // ---------- Request handling ----------

  async #handle(req, res) {
    try {
      if (req.url.length > MAX_URL_LENGTH) throw new HttpError(414, 'URL too long');
      if (!this.#isLocalHost(req.headers.host)) throw new HttpError(403, 'Forbidden host');
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        throw new HttpError(405, 'This API is read-only: only GET is allowed');
      }
      if (Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding']) {
        throw new HttpError(413, 'Request bodies are not accepted');
      }

      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        return sendJson(res, 200, this.#route(url));
      }
      return await this.#serveStatic(res, url.pathname);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof HttpError ? err.message : 'Internal server error';
      // Close the connection after errors: there may be an unread body.
      res.setHeader('Connection', 'close');
      sendJson(res, status, { error: message });
    }
  }

  #isLocalHost(hostHeader) {
    if (typeof hostHeader !== 'string') return false;
    const allowed = [`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`];
    return allowed.includes(hostHeader.toLowerCase());
  }

  #route(url) {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const [, resource, id, sub, ref, ...rest] = parts;

    if (parts.length === 2 && resource === 'health') return { ok: true, nodes: this.#nodes.size };
    if (parts.length === 2 && resource === 'network') return this.#network();
    if (parts.length === 2 && resource === 'mempool') return this.#networkMempool();
    if (parts.length === 2 && resource === 'nodes') {
      return { nodes: [...this.#nodes.values()].map((n) => ({ id: n.id, height: n.height, tipHash: n.tipHash })) };
    }
    if (resource !== 'nodes' || parts.length < 3 || rest.length > 0) throw new HttpError(404, 'Not found');

    const node = this.#getNode(id);
    if (parts.length === 3) return this.#summary(node);
    if (parts.length === 4 && sub === 'status') return this.#status(node);
    if (parts.length === 4 && sub === 'blocks') return this.#blocks(node, url.searchParams);
    if (parts.length === 5 && sub === 'blocks') return this.#block(node, ref);
    if (parts.length === 4 && sub === 'transactions') return this.#transactions(node, url.searchParams);
    if (parts.length === 4 && sub === 'balances') return this.#balances(node);
    if (parts.length === 4 && sub === 'mempool') return this.#mempool(node);
    if (parts.length === 4 && sub === 'contracts') return this.#contracts(node);
    if (parts.length === 5 && sub === 'contracts') return this.#contract(node, ref);
    if (parts.length === 4 && sub === 'peers') return { nodeId: node.id, peers: node.peerIds };
    throw new HttpError(404, 'Not found');
  }

  #getNode(id) {
    if (!isNodeId(id)) throw new HttpError(400, 'Invalid node id');
    const node = this.#nodes.get(id);
    if (!node) throw new HttpError(404, `Unknown node: ${id}`);
    return node;
  }

  #label(address) {
    return Object.hasOwn(this.#labels, address) ? this.#labels[address] : null;
  }

  // ---------- Endpoints ----------

  #network() {
    const nodes = [...this.#nodes.values()];
    const views = nodes.map((node) => ({
      id: node.id,
      height: node.height,
      tipHash: node.tipHash,
      work: chainWork(node.ledger).toString(),
      peers: node.peerIds,
      valid: node.ledger.validate().valid,
      pendingCount: node.mempool.size,
      recent: node.ledger.chain.slice(-RECENT_BLOCKS).map((b) => ({ height: b.index, hash: b.hash })),
    }));

    // Highest height at which EVERY node has the same block.
    let commonHeight = 0;
    const minLength = Math.min(...nodes.map((n) => n.ledger.chain.length));
    while (
      commonHeight + 1 < minLength &&
      nodes.every((n) => n.ledger.chain[commonHeight + 1].hash === nodes[0].ledger.chain[commonHeight + 1].hash)
    ) {
      commonHeight++;
    }

    const distinctTips = new Set(views.map((v) => v.tipHash)).size;
    return {
      inSync: distinctTips === 1,
      distinctTips,
      commonHeight,
      bestHeight: Math.max(...views.map((v) => v.height)),
      nodes: views,
    };
  }

  #summary(node) {
    const { genesisHash, difficulty, protocol } = node.consensusParams;
    return {
      id: node.id,
      p2pPort: node.port,
      height: node.height,
      tipHash: node.tipHash,
      genesisHash,
      difficulty,
      protocol,
      work: chainWork(node.ledger).toString(),
      validation: node.ledger.validate(),
      peers: node.peerIds,
      totalSupply: node.ledger.totalSupply,
      unit: 'fictional MiniChain coins',
      pendingCount: node.mempool.size,
      mempoolLimits: node.mempool.limits,
      contractCount: node.ledger.getContracts().length,
      recentBlocks: node.ledger.chain.slice(-5).reverse().map((b) => this.#blockSummary(b, node)),
    };
  }

  #status(node) {
    return {
      id: node.id,
      validation: node.ledger.validate(),
      consensus: { ...node.consensusParams, rule: 'Most accumulated proof-of-work; ties keep the first-seen chain' },
      height: node.height,
      work: chainWork(node.ledger).toString(),
    };
  }

  #blocks(node, params) {
    const { offset, limit } = pageParams(params);
    const newestFirst = [...node.ledger.chain].reverse();
    return {
      nodeId: node.id,
      total: newestFirst.length,
      offset,
      limit,
      blocks: newestFirst.slice(offset, offset + limit).map((b) => this.#blockSummary(b, node)),
    };
  }

  #block(node, ref) {
    let block;
    if (HEIGHT.test(ref)) block = node.ledger.chain[Number(ref)];
    else if (HEX64.test(ref)) block = node.ledger.chain.find((b) => b.hash === ref);
    else throw new HttpError(400, 'Block reference must be a height or a 64-character hash');
    if (!block) throw new HttpError(404, `Block ${ref} is not in ${node.id}'s chain`);

    const detail = { ...this.#blockSummary(block, node), meetsDifficulty: block.hasValidProof(node.ledger.difficulty) };
    if (block.index === 0) {
      detail.allocation = block.data.allocation.map((a) => ({ ...a, label: this.#label(a.address) }));
    } else {
      detail.transactions = block.data.transactions.map((tx) => this.#txView(tx, block, node));
    }
    return detail;
  }

  #transactions(node, params) {
    const { offset, limit } = pageParams(params);
    const all = [];
    for (let i = node.ledger.chain.length - 1; i >= 1; i--) {
      const block = node.ledger.chain[i];
      for (let j = block.data.transactions.length - 1; j >= 0; j--) {
        all.push({ tx: block.data.transactions[j], block });
      }
    }
    return {
      nodeId: node.id,
      total: all.length,
      offset,
      limit,
      transactions: all.slice(offset, offset + limit).map(({ tx, block }) => this.#txView(tx, block, node)),
      pending: {
        supported: true,
        count: node.mempool.size,
        note: `Pending (not yet mined) transactions are listed at /api/nodes/${node.id}/mempool.`,
      },
    };
  }

  /** One node's own mempool: what IT has checked and is waiting to mine. */
  #mempool(node) {
    return {
      nodeId: node.id,
      height: node.height,
      count: node.mempool.size,
      limits: node.mempool.limits,
      transactions: node.getPendingTransactions().map((entry) => this.#pendingView(entry)),
    };
  }

  /**
   * Every pending transaction any node knows, plus each node's most recently
   * confirmed ones, with each node's view of it: pending / confirmed / unknown.
   * Nodes are never assumed to agree — each column comes from that node alone.
   */
  #networkMempool() {
    const nodes = [...this.#nodes.values()];
    const views = new Map(); // node id → { pending: Map(txId → entry), confirmed: Map(txId → { tx, block }) }
    for (const node of nodes) {
      const pending = new Map(node.getPendingTransactions().map((e) => [e.id, e]));
      const confirmed = new Map();
      for (const block of node.ledger.chain.slice(1)) {
        for (const tx of block.data.transactions) confirmed.set(transactionId(tx), { tx, block });
      }
      views.set(node.id, { pending, confirmed });
    }

    // Which transactions to show: all pending + each node's recent confirmed.
    const rows = new Map(); // txId → tx data
    for (const { pending, confirmed } of views.values()) {
      for (const [id, entry] of pending) rows.set(id, entry.tx);
      for (const [id, { tx }] of [...confirmed].slice(-RECENT_CONFIRMED_PER_NODE)) rows.set(id, tx);
    }

    const transactions = [...rows]
      .sort(([idA, a], [idB, b]) => b.timestamp - a.timestamp || (idA < idB ? -1 : 1))
      .slice(0, MAX_MEMPOOL_ROWS)
      .map(([id, tx]) => {
        const statusByNode = {};
        for (const node of nodes) {
          const { pending, confirmed } = views.get(node.id);
          if (confirmed.has(id)) statusByNode[node.id] = { status: 'confirmed', blockHeight: confirmed.get(id).block.index };
          else if (pending.has(id)) statusByNode[node.id] = { status: 'pending', source: pending.get(id).source };
          else statusByNode[node.id] = { status: 'unknown' };
        }
        const count = (s) => Object.values(statusByNode).filter((v) => v.status === s).length;
        return {
          id,
          sender: tx.sender,
          senderLabel: this.#label(tx.sender),
          recipient: tx.recipient,
          recipientLabel: this.#label(tx.recipient),
          amount: tx.amount,
          nonce: tx.nonce,
          timestamp: tx.timestamp,
          statusByNode,
          pendingOn: count('pending'),
          confirmedOn: count('confirmed'),
          unknownOn: count('unknown'),
        };
      });

    const pendingSets = nodes.map((n) => [...views.get(n.id).pending.keys()].sort().join());
    return {
      inSync: new Set(pendingSets).size <= 1,
      nodes: nodes.map((node) => {
        const own = views.get(node.id).pending;
        // Pending somewhere else, but this node has never heard of it.
        const missing = transactions.filter((t) => t.statusByNode[node.id].status === 'unknown' && t.pendingOn > 0).length;
        return { id: node.id, pendingCount: own.size, missing };
      }),
      transactions,
    };
  }

  #balances(node) {
    let accounts;
    try {
      accounts = node.ledger.getAccounts();
    } catch (err) {
      throw new HttpError(409, err.message); // refuses to report balances from an invalid chain
    }
    return {
      nodeId: node.id,
      height: node.height,
      unit: 'fictional MiniChain coins',
      totalSupply: node.ledger.totalSupply,
      // Coins held by escrow contracts belong to no account until claimed or
      // refunded, so: sum(account balances) + lockedInContracts = totalSupply.
      lockedInContracts: node.ledger.getContracts().reduce((sum, c) => sum + c.balance, 0),
      accounts: accounts.map((a) => ({ ...a, label: this.#label(a.address) })),
    };
  }

  /** Confirmed contracts in THIS node's chain (never another node's view). */
  #contracts(node) {
    const pendingByContract = new Map();
    for (const { tx } of node.getPendingTransactions()) {
      if (tx.contract) pendingByContract.set(tx.recipient, (pendingByContract.get(tx.recipient) ?? 0) + 1);
    }
    const contracts = node.ledger.getContracts()
      .map((c) => this.#contractView(c, node, pendingByContract.get(c.id) ?? 0))
      .sort((a, b) => b.deployedAt - a.deployedAt || (a.id < b.id ? -1 : 1));
    return { nodeId: node.id, height: node.height, nextHeight: node.height + 1, count: contracts.length, limit: MAX_CONTRACTS, contracts };
  }

  #contract(node, id) {
    if (!isValidContractId(id)) throw new HttpError(400, 'Contract ID must be "CT" followed by 40 lowercase hex characters');
    const contract = node.ledger.getContract(id);
    const pending = node.getPendingTransactions().filter((e) => e.tx.recipient === id);
    if (!contract) {
      throw new HttpError(404, `Contract ${id} is not in ${node.id}'s chain`
        + (pending.length ? ' (a deployment is pending in its mempool)' : ''));
    }
    const activity = [];
    for (const block of node.ledger.chain.slice(1)) {
      for (const tx of block.data.transactions) {
        if (tx.recipient === id) activity.push(this.#txView(tx, block, node));
      }
    }
    return {
      ...this.#contractView(contract, node, pending.length),
      activity: activity.reverse(), // newest first
      pending: pending.map((entry) => this.#pendingView(entry)),
    };
  }

  #contractView(c, node, pendingOps) {
    const nextHeight = node.height + 1; // the earliest block a new call could land in
    return {
      id: c.id,
      template: c.template,
      type: 'Timelock escrow',
      creator: c.creator,
      creatorLabel: this.#label(c.creator),
      beneficiary: c.beneficiary,
      beneficiaryLabel: this.#label(c.beneficiary),
      amount: c.amount,
      balance: c.balance,
      status: c.status,
      phase: contractPhase(c, nextHeight),
      unlockHeight: c.unlockHeight,
      expiryHeight: c.expiryHeight,
      deployedAt: c.deployedAt,
      updatedAt: c.updatedAt,
      nextHeight,
      pendingOps,
    };
  }

  /** Which way the coins move — contract withdrawals flow OUT to the signer. */
  #flow(tx) {
    const op = tx.contract?.op ?? null;
    if (op && isWithdrawal(op)) {
      return { from: tx.recipient, fromLabel: 'Escrow contract', to: tx.sender, toLabel: this.#label(tx.sender) };
    }
    return {
      from: tx.sender,
      fromLabel: this.#label(tx.sender),
      to: tx.recipient,
      toLabel: op ? 'Escrow contract' : this.#label(tx.recipient),
    };
  }

  /** Fields shared by confirmed and pending transaction views. */
  #txKind(tx) {
    const op = tx.contract?.op ?? null;
    return {
      kind: op ?? 'transfer',
      contractId: op ? tx.recipient : null,
      call: tx.contract ? structuredClone(tx.contract) : null,
      flow: this.#flow(tx),
    };
  }

  // ---------- Views ----------

  #blockSummary(block, node) {
    const isGenesis = block.index === 0;
    return {
      height: block.index,
      hash: block.hash,
      previousHash: block.previousHash,
      timestamp: block.timestamp,
      nonce: block.nonce,
      isGenesis,
      transactionCount: isGenesis ? 0 : block.data.transactions.length,
      confirmations: node.height - block.index + 1,
    };
  }

  #pendingView({ id, tx, receivedAt, source }) {
    let signatureValid = false;
    try {
      signatureValid = Transaction.fromJSON(tx).isValid();
    } catch {
      // malformed data simply counts as "not valid"
    }
    return {
      id,
      status: 'pending',
      sender: tx.sender,
      senderLabel: this.#label(tx.sender),
      recipient: tx.recipient,
      recipientLabel: this.#label(tx.recipient),
      amount: tx.amount,
      nonce: tx.nonce,
      timestamp: tx.timestamp,
      receivedAt,
      source, // 'local', 'orphan-recovery', or the peer it came from
      signatureValid,
      ...this.#txKind(tx),
    };
  }

  #txView(tx, block, node) {
    let signatureValid = false;
    try {
      signatureValid = Transaction.fromJSON(tx).isValid();
    } catch {
      // malformed data simply counts as "not valid"
    }
    return {
      id: transactionId(tx),
      status: 'confirmed',
      sender: tx.sender,
      senderLabel: this.#label(tx.sender),
      recipient: tx.recipient,
      recipientLabel: this.#label(tx.recipient),
      amount: tx.amount,
      nonce: tx.nonce,
      timestamp: tx.timestamp,
      senderPublicKey: tx.senderPublicKey,
      signature: tx.signature,
      signatureValid,
      blockHeight: block.index,
      blockHash: block.hash,
      confirmations: node.height - block.index + 1,
      ...this.#txKind(tx),
    };
  }

  // ---------- Static frontend ----------

  async #serveStatic(res, pathname) {
    if (!this.#staticDir || !(await isFile(path.join(this.#staticDir, 'index.html')))) {
      return sendText(res, 503, 'text/plain; charset=utf-8',
        'Frontend not built yet. Run: npm run explorer:install && npm run explorer:build\n');
    }
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'Malformed URL');
    }
    if (decoded.includes('\0')) throw new HttpError(400, 'Malformed URL');

    // Resolve inside staticDir and refuse anything that escapes it (e.g. "/..%2f").
    const filePath = path.resolve(this.#staticDir, `.${decoded}`);
    if (filePath !== this.#staticDir && !filePath.startsWith(this.#staticDir + path.sep)) {
      throw new HttpError(404, 'Not found');
    }

    if (await isFile(filePath)) return sendFile(res, filePath);
    // Paths without a file extension are app routes: serve the app shell.
    if (!path.extname(decoded)) return sendFile(res, path.join(this.#staticDir, 'index.html'));
    throw new HttpError(404, 'Not found');
  }
}

// ---------- Helpers ----------

function pageParams(params) {
  return {
    offset: intParam(params, 'offset', 0, 0, 1_000_000),
    limit: intParam(params, 'limit', DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
  };
}

function intParam(params, name, fallback, min, max) {
  if (!params.has(name)) return fallback;
  const raw = params.get(name);
  if (!/^[0-9]{1,7}$/.test(raw)) throw new HttpError(400, `${name} must be a whole number`);
  const value = Number(raw);
  if (value < min || value > max) throw new HttpError(400, `${name} must be between ${min} and ${max}`);
  return value;
}

function sendJson(res, status, body) {
  sendText(res, status, 'application/json; charset=utf-8', JSON.stringify(body));
}

function sendText(res, status, contentType, text) {
  if (res.headersSent) return res.end();
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function sendFile(res, filePath) {
  const body = await readFile(filePath);
  const type = CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream';
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': type,
    'Content-Length': body.length,
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
  });
  res.end(body);
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}
