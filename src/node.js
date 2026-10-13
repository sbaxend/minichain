/**
 * node.js — one independent MiniChain participant.
 *
 * A Node has:
 *   • its own Ledger (never shared with any other node)
 *   • a TCP server, bound to 127.0.0.1 by default (local-only)
 *   • a set of connected peers
 *
 * It never trusts a peer. Every chain it hears about is rebuilt from plain
 * data, validated with OUR allocation and difficulty, and adopted only if it
 * has strictly more accumulated proof-of-work than what we already have.
 *
 * It also keeps its own MEMPOOL of pending transactions: each one is checked
 * independently before it is stored or passed on to peers (gossip).
 *
 * Events (useful for demos and tests):
 *   'peerConnected'    (peerId)
 *   'peerDisconnected' (peerId)
 *   'chainUpdated'     ({ source, height, tipHash, reorg })
 *   'reorg'            (reorg)               — only when blocks were abandoned
 *   'chainRejected'    ({ source, reason })  — an INVALID chain was offered
 *   'peerError'        ({ peerId, message }) — a peer told us we did something wrong
 *   'txAccepted'       ({ id, tx, source })  — a new pending tx entered our mempool
 *   'txKnown'          ({ id, source })      — a duplicate arrived (normal in gossip)
 *   'txRejected'       ({ id, reason, fault, source })
 *   'txRelayed'        ({ id, to })          — we passed a tx on to these peers
 *   'mempoolSynced'    ({ peerId, accepted, known, rejected }) — pulled a peer's pool
 *   'mempoolChanged'   ({ confirmed, kept, recovered, dropped, skippedRecovery })
 */
import net from 'node:net';
import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Ledger, applyTransaction } from './ledger.js';
import { Transaction } from './transaction.js';
import { DEFAULT_DIFFICULTY } from './blockchain.js';
import { PROTOCOL_VERSION, isNodeId } from './protocol.js';
import { Peer } from './peer.js';
import { chooseChain, describeReorg, transactionId } from './consensus.js';
import { Mempool, MAX_POOL_SIZE, MAX_PER_SENDER } from './mempool.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
// At most this many pending transactions go into one mined block. Keeps blocks
// (and whole-chain sync messages) small.
export const MAX_BLOCK_TRANSACTIONS = 100;
// At most this many transactions from abandoned blocks are re-checked per
// reorganization, so a deep reorg can't trigger unbounded work.
export const MAX_ORPHAN_RECOVERY = 200;

export class Node extends EventEmitter {
  #server = null;
  #peers = new Map(); // peerId → Peer (handshake complete)
  #connections = new Set(); // every open Peer, including mid-handshake
  #requestTimeoutMs;
  #maxBlockTransactions;
  #maxOrphanRecovery;
  #confirmedCache = null; // { tip, ids } — see #confirmedTxIds

  /**
   * @param {object} options
   * @param {string} [options.id]          - Unique name, e.g. "alice". Random if omitted.
   * @param {Array}  options.allocation    - Genesis allocation (must match peers').
   * @param {number} [options.difficulty]  - Proof-of-work difficulty (must match peers').
   * @param {string} [options.host]        - Interface to listen on. Local-only by default.
   * @param {number} [options.requestTimeoutMs]
   * @param {number} [options.maxPoolSize]          - Mempool capacity.
   * @param {number} [options.maxPerSender]         - Pending txs allowed per sender.
   * @param {number} [options.maxBlockTransactions] - Txs per block from the mempool.
   * @param {number} [options.maxOrphanRecovery]    - Orphaned txs re-checked per reorg.
   */
  constructor({
    id = `node-${randomUUID().slice(0, 8)}`,
    allocation,
    difficulty = DEFAULT_DIFFICULTY,
    host = '127.0.0.1',
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxPoolSize = MAX_POOL_SIZE,
    maxPerSender = MAX_PER_SENDER,
    maxBlockTransactions = MAX_BLOCK_TRANSACTIONS,
    maxOrphanRecovery = MAX_ORPHAN_RECOVERY,
  }) {
    super();
    if (!isNodeId(id)) throw new TypeError('Node id must be 1–32 letters, digits, _ or -');
    this.id = id;
    this.host = host;
    this.port = null;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#maxBlockTransactions = maxBlockTransactions;
    this.#maxOrphanRecovery = maxOrphanRecovery;
    this.ledger = new Ledger(allocation, difficulty); // this node's own copy
    this.mempool = new Mempool({ maxSize: maxPoolSize, maxPerSender }); // this node's own pool
    // Simple counters, so tests and the explorer can see gossip is bounded.
    this.stats = { txReceived: 0, txRelayed: 0, txKnown: 0, txRejected: 0 };
  }

  // ---------- Info ----------

  /** The rules every peer must share. Exchanged in the handshake. */
  get consensusParams() {
    return {
      protocol: PROTOCOL_VERSION,
      genesisHash: this.ledger.genesisHash,
      difficulty: this.ledger.difficulty,
    };
  }

  get peerIds() {
    return [...this.#peers.keys()].sort();
  }

  get height() {
    return this.ledger.chain.length - 1;
  }

  get tipHash() {
    return this.ledger.getLatestBlock().hash;
  }

  getBalance(address) {
    return this.ledger.getBalance(address);
  }

  // ---------- Lifecycle ----------

  /** Start listening. Port 0 = let the OS pick a free port. */
  async start(port = 0) {
    this.#server = net.createServer((socket) => this.#adopt(socket, false));
    this.#server.listen(port, this.host);
    await once(this.#server, 'listening');
    this.port = this.#server.address().port;
    return this.port;
  }

  /** Close every connection and stop listening. Safe to call more than once. */
  async stop() {
    await Promise.all([...this.#connections].map((peer) => peer.close()));
    if (this.#server?.listening) {
      await new Promise((resolve) => this.#server.close(resolve));
    }
  }

  // ---------- Peers ----------

  /**
   * Connect to another node and complete the handshake.
   * Rejects if the other node has different consensus rules.
   *
   * @returns {Promise<string>} The peer's node ID.
   */
  async connect(port, host = '127.0.0.1') {
    const socket = net.createConnection({ port, host });
    await once(socket, 'connect'); // rejects if nothing is listening
    const peer = this.#adopt(socket, true);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('Handshake timed out')), this.#requestTimeoutMs);
      timer.unref();
      const fail = (err) => {
        clearTimeout(timer);
        peer.close();
        reject(err);
      };
      peer.handshake = {
        resolve: (id) => { clearTimeout(timer); resolve(id); },
        reject: fail,
      };
      peer.send({ type: 'HELLO', nodeId: this.id, ...this.consensusParams });
    });
  }

  /** Disconnect from one peer. Resolves once the connection is closed. */
  async disconnect(peerId) {
    const peer = this.#peers.get(peerId);
    if (peer) await peer.close();
  }

  /** Disconnect from everyone (but keep listening). */
  async disconnectAll() {
    await Promise.all(this.peerIds.map((id) => this.disconnect(id)));
  }

  // ---------- Blocks & chains ----------

  /**
   * Mine a block of transactions on our chain and announce it to all peers.
   * Throws (and changes nothing) if any transaction is invalid.
   */
  mineBlock(transactions, timestamp) {
    const block = this.ledger.addBlock(transactions, timestamp);
    this.#maintainMempool({ forkHeight: this.height - 1, orphanedTransactions: [] });
    this.emit('chainUpdated', { source: this.id, height: this.height, tipHash: this.tipHash, reorg: null });
    this.announceTip();
    return block;
  }

  /**
   * Mine a block from our mempool:
   *   1. re-check every pending tx against the CURRENT confirmed ledger
   *   2. take up to `maxTransactions` in deterministic (sender, nonce) order
   *   3. mine them with mineBlock (which validates them all once more)
   *
   * @returns {import('./block.js').Block|null} null if nothing valid is pending.
   */
  mineFromMempool({ maxTransactions = this.#maxBlockTransactions, timestamp } = {}) {
    const recheck = this.mempool.rebuild(this.ledger.getState());
    this.#reportMempoolChange(recheck, 0);
    // Build the block GREEDILY: apply candidates in mining order to a scratch
    // copy of the state and keep only those that still fit. The mempool checks
    // each sender separately, so this is where txs from different senders are
    // checked TOGETHER (e.g. the contract limit, or two parties racing on one
    // contract). Skipped txs stay pending and are re-checked after the block.
    const state = this.ledger.getState();
    const context = { height: this.height + 1 };
    const transactions = [];
    for (const tx of this.mempool.selectForBlock(this.mempool.size)) {
      if (transactions.length >= maxTransactions) break;
      if (applyTransaction(state, tx, context) === null) transactions.push(tx);
    }
    if (transactions.length === 0) return null;
    return this.mineBlock(transactions, timestamp);
  }

  // ---------- Pending transactions ----------

  /**
   * Submit a transaction from THIS node (e.g. a local wallet). If our mempool
   * accepts it, it is relayed to every peer.
   *
   * @returns {{ status: 'accepted'|'known'|'rejected', id?: string, reason?: string }}
   */
  submitTransaction(tx) {
    return this.#admit(tx, null);
  }

  /** Pending transactions (copies), in mining order, with arrival info. */
  getPendingTransactions() {
    return this.mempool.entries();
  }

  /** Ask every peer for its pending transactions and check each one ourselves. */
  async syncMempool() {
    const results = [];
    for (const peer of [...this.#peers.values()]) results.push(await this.#pullMempool(peer));
    return results;
  }

  /** Tell peers about our latest block (all except `exceptPeerId`). */
  announceTip(exceptPeerId = null) {
    const message = { type: 'NEW_BLOCK', block: this.ledger.getLatestBlock().toJSON() };
    for (const [id, peer] of this.#peers) {
      if (id !== exceptPeerId) peer.send(message);
    }
  }

  /**
   * Ask every peer for its chain and adopt the best valid one, THEN pull their
   * pending transactions (so they're checked against the best chain).
   * @returns {Promise<Array<object>>} One decision per peer (+ mempool counts).
   */
  async sync() {
    const results = [];
    for (const peer of [...this.#peers.values()]) {
      results.push({ peer: peer.id, ...(await this.#syncWithPeer(peer)) });
    }
    for (const result of results) {
      const peer = this.#peers.get(result.peer);
      if (peer) result.mempool = await this.#pullMempool(peer);
    }
    return results;
  }

  /**
   * Consider a proposed chain (plain block data). This is the heart of consensus.
   *
   *   1. Rebuild + fully validate it with OUR rules  (Ledger.fromBlocks)
   *   2. Compare accumulated work                    (chooseChain)
   *   3. If strictly more work: swap in the new ledger in ONE assignment
   *
   * Our current ledger is never modified, so a rejected candidate leaves
   * everything exactly as it was.
   *
   * @returns {{ adopted: boolean, invalid: boolean, reason: string, reorg?: object }}
   */
  receiveChain(blocks, source = null) {
    let candidate;
    try {
      candidate = Ledger.fromBlocks(this.ledger.allocation, this.ledger.difficulty, blocks);
    } catch (err) {
      this.emit('chainRejected', { source, reason: err.message });
      return { adopted: false, invalid: true, reason: err.message };
    }

    const decision = chooseChain(this.ledger, candidate);
    if (!decision.adopt) return { adopted: false, invalid: false, reason: decision.reason };

    const reorg = describeReorg(this.ledger, candidate);
    this.ledger = candidate; // ← the atomic switch
    this.#maintainMempool(reorg);
    this.emit('chainUpdated', { source, height: this.height, tipHash: this.tipHash, reorg });
    if (reorg.removedBlocks.length > 0) this.emit('reorg', reorg);
    this.announceTip(source); // pass the news on (gossip)
    return { adopted: true, invalid: false, reason: decision.reason, reorg };
  }

  // ---------- Private: mempool ----------

  /**
   * Check a transaction against our confirmed ledger + mempool. If accepted,
   * relay it to every peer except the one it came from. "known" and
   * "rejected" are never relayed — that's what stops gossip loops.
   */
  #admit(txData, fromPeerId, state = this.#confirmedState()) {
    // Already in our chain? That's old news, not an invalid transaction. (It
    // happens when a relayed copy arrives after the block that confirmed it.)
    const id = safeTransactionId(txData);
    if (id && this.#confirmedTxIds().has(id)) {
      this.stats.txKnown++;
      this.emit('txKnown', { id, source: fromPeerId, confirmed: true });
      return { status: 'known', id, confirmed: true };
    }
    const result = state
      ? this.mempool.add(txData, state, { source: fromPeerId ?? 'local' })
      : { status: 'rejected', reason: 'Our own chain is invalid; not accepting transactions', fault: false };
    if (result.status === 'accepted') {
      const { tx } = this.mempool.get(result.id);
      this.emit('txAccepted', { id: result.id, tx, source: fromPeerId });
      this.#relay(result.id, tx, fromPeerId);
    } else if (result.status === 'known') {
      this.stats.txKnown++;
      this.emit('txKnown', { id: result.id, source: fromPeerId });
    } else {
      this.stats.txRejected++;
      this.emit('txRejected', { id: result.id ?? null, reason: result.reason, fault: result.fault, source: fromPeerId });
    }
    return result;
  }

  /** IDs of every transaction in our chain, cached per tip (recomputed when it changes). */
  #confirmedTxIds() {
    if (this.#confirmedCache?.tip !== this.tipHash) {
      const ids = new Set();
      for (const block of this.ledger.chain.slice(1)) {
        for (const tx of block.data.transactions ?? []) ids.add(transactionId(tx));
      }
      this.#confirmedCache = { tip: this.tipHash, ids };
    }
    return this.#confirmedCache.ids;
  }

  /**
   * Our confirmed state, or null if our OWN chain is invalid. That can't happen
   * to an honest node, but a tampered ledger must not crash message handling.
   */
  #confirmedState() {
    try {
      return this.ledger.getState();
    } catch {
      return null;
    }
  }

  #relay(id, tx, exceptPeerId) {
    const to = [];
    for (const [peerId, peer] of this.#peers) {
      if (peerId === exceptPeerId) continue;
      peer.send({ type: 'NEW_TX', transaction: tx });
      to.push(peerId);
    }
    this.stats.txRelayed += to.length;
    if (to.length) this.emit('txRelayed', { id, to });
  }

  /** Request a peer's pending transactions and check every one ourselves. */
  async #pullMempool(peer) {
    peer.mempoolRequested = true;
    let reply;
    try {
      reply = await peer.request({ type: 'GET_MEMPOOL' });
    } catch (err) {
      return { peerId: peer.id, accepted: 0, known: 0, rejected: 0, error: err.message };
    }
    // Sort by (sender, nonce) so each sender's transactions arrive in order.
    const key = (tx) => [typeof tx?.sender === 'string' ? tx.sender : '', Number.isSafeInteger(tx?.nonce) ? tx.nonce : 0];
    const ordered = [...reply.transactions].sort((a, b) => {
      const [sa, na] = key(a);
      const [sb, nb] = key(b);
      return sa === sb ? na - nb : sa < sb ? -1 : 1;
    });
    const counts = { peerId: peer.id, accepted: 0, known: 0, rejected: 0 };
    let faults = 0;
    const state = this.#confirmedState(); // one replay for the whole batch
    for (const tx of ordered) {
      const result = this.#admit(tx, peer.id, state);
      counts[result.status]++;
      if (result.fault) faults++;
    }
    if (faults > 0) peer.misbehave(`Sent ${faults} invalid transaction(s)`);
    this.emit('mempoolSynced', counts);
    return counts;
  }

  /**
   * After any chain change: drop transactions that are now confirmed, re-check
   * the rest against the new state, and try to recover transactions from
   * abandoned blocks (bounded). Recovered ones are relayed to peers.
   */
  #maintainMempool(reorg) {
    const added = this.ledger.chain.slice(reorg.forkHeight + 1);
    const confirmedIds = new Set(added.flatMap((b) => b.data.transactions.map(transactionId)));
    const orphans = reorg.orphanedTransactions;
    const recover = orphans.slice(0, this.#maxOrphanRecovery);
    const result = this.mempool.rebuild(this.ledger.getState(), { confirmedIds, recover });
    for (const id of result.recovered) this.#relay(id, this.mempool.get(id).tx, null);
    this.#reportMempoolChange(result, orphans.length - recover.length);
    return result;
  }

  #reportMempoolChange(result, skippedRecovery) {
    if (result.confirmed.length || result.dropped.length || result.recovered.length || skippedRecovery) {
      this.emit('mempoolChanged', { ...result, skippedRecovery });
    }
  }

  // ---------- Private: connections & messages ----------

  #adopt(socket, outbound) {
    const peer = new Peer(socket, {
      outbound,
      requestTimeoutMs: this.#requestTimeoutMs,
      onMessage: (p, message) => this.#onMessage(p, message),
      onClose: (p) => this.#onClose(p),
    });
    this.#connections.add(peer);
    return peer;
  }

  #onClose(peer) {
    this.#connections.delete(peer);
    peer.handshake?.reject(new Error('Connection closed during handshake'));
    if (peer.id && this.#peers.get(peer.id) === peer) {
      this.#peers.delete(peer.id);
      this.emit('peerDisconnected', peer.id);
    }
  }

  /** Why we can't connect to a node with these handshake details, or null if we can. */
  #incompatibility(hello) {
    const ours = this.consensusParams;
    if (hello.protocol !== ours.protocol) return `Protocol mismatch: we speak ${ours.protocol}`;
    if (hello.genesisHash !== ours.genesisHash) return 'Different genesis block (allocation)';
    if (hello.difficulty !== ours.difficulty) return `Difficulty mismatch: we require ${ours.difficulty}`;
    if (hello.nodeId === this.id) return 'Cannot connect to yourself';
    if (this.#peers.has(hello.nodeId)) return `Already connected to ${hello.nodeId}`;
    return null;
  }

  #register(peer, peerId) {
    peer.id = peerId;
    this.#peers.set(peerId, peer);
    this.emit('peerConnected', peerId);
  }

  async #onMessage(peer, message) {
    if (!peer.id) return this.#onHandshakeMessage(peer, message);

    switch (message.type) {
      case 'NEW_BLOCK':
        return this.#onNewBlock(peer, message.block);
      case 'GET_CHAIN':
        return peer.send({ type: 'CHAIN', requestId: message.requestId, blocks: this.ledger.exportBlocks() });
      case 'CHAIN':
        if (!peer.resolveRequest(message.requestId, message)) peer.misbehave('Unexpected CHAIN reply');
        return;
      case 'NEW_TX': {
        this.stats.txReceived++;
        const result = this.#admit(message.transaction, peer.id);
        // Only PROVABLY bad txs count against the peer. A nonce or balance
        // rejection can be honest: the peer may be on a different branch.
        if (result.fault) peer.misbehave(`Invalid transaction: ${result.reason}`);
        return;
      }
      case 'GET_MEMPOOL':
        peer.send({ type: 'MEMPOOL', requestId: message.requestId, transactions: this.mempool.transactions() });
        // Exchange is two-way: the first time a peer asks, we ask back.
        if (!peer.mempoolRequested) this.#pullMempool(peer);
        return;
      case 'MEMPOOL':
        if (!peer.resolveRequest(message.requestId, message)) peer.misbehave('Unexpected MEMPOOL reply');
        return;
      case 'ERROR':
        this.emit('peerError', { peerId: peer.id, message: message.message });
        return;
      default: // HELLO / HELLO_ACK after the handshake
        peer.misbehave('Already connected');
    }
  }

  #onHandshakeMessage(peer, message) {
    // Inbound side: wait for HELLO, check rules, reply HELLO_ACK.
    if (!peer.outbound && message.type === 'HELLO') {
      const problem = this.#incompatibility(message);
      if (problem) {
        peer.send({ type: 'ERROR', message: problem });
        return peer.close();
      }
      this.#register(peer, message.nodeId);
      return peer.send({ type: 'HELLO_ACK', nodeId: this.id, ...this.consensusParams });
    }
    // Outbound side: we sent HELLO, now expect HELLO_ACK (and check it too!).
    if (peer.outbound && message.type === 'HELLO_ACK') {
      const problem = this.#incompatibility(message);
      if (problem) return peer.handshake.reject(new Error(problem));
      this.#register(peer, message.nodeId);
      const { resolve } = peer.handshake;
      peer.handshake = null;
      resolve(message.nodeId);
      // On every (re)connection, exchange pending transactions. The chain is
      // NOT synced automatically — that stays an explicit sync().
      this.#pullMempool(peer);
      return;
    }
    if (peer.outbound && message.type === 'ERROR') {
      return peer.handshake.reject(new Error(`Peer refused: ${message.message}`));
    }
    peer.misbehave('Handshake required first');
  }

  async #onNewBlock(peer, blockJson) {
    if (this.ledger.chain.some((b) => b.hash === blockJson.hash)) return; // already have it

    // Fast path: the block extends our tip. Validate our chain + this block.
    if (blockJson.previousHash === this.tipHash) {
      const result = this.receiveChain([...this.ledger.exportBlocks(), blockJson], peer.id);
      if (result.invalid) this.#punish(peer, result.reason);
      return;
    }
    // Otherwise we're behind or on a different branch: ask for the whole chain.
    await this.#syncWithPeer(peer);
  }

  async #syncWithPeer(peer) {
    let reply;
    try {
      reply = await peer.request({ type: 'GET_CHAIN' });
    } catch (err) {
      return { adopted: false, invalid: false, reason: err.message };
    }
    const result = this.receiveChain(reply.blocks, peer.id);
    if (result.invalid) this.#punish(peer, result.reason);
    return result;
  }

  /** An honest node never sends an invalid chain, so disconnect peers that do. */
  #punish(peer, reason) {
    peer.send({ type: 'ERROR', message: `Invalid chain rejected: ${reason}`.slice(0, 500) });
    peer.close();
  }
}

/** A transaction's ID, or null if the data is too malformed to have one. */
function safeTransactionId(txData) {
  try {
    const plain = txData instanceof Transaction ? txData.toJSON() : txData;
    return transactionId(Transaction.fromJSON(plain).toJSON());
  } catch {
    return null;
  }
}
