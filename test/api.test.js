/**
 * Read-only explorer API, tested over real HTTP on 127.0.0.1 (random port).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { Wallet } from '../src/wallet.js';
import { Node } from '../src/node.js';
import { ExplorerApi } from '../src/api.js';

const TIMEOUT = { timeout: 15_000 };
const alice = new Wallet();
const bob = new Wallet();
const ALLOCATION = [
  { address: alice.address, amount: 100 },
  { address: bob.address, amount: 50 },
];
const LABELS = { [alice.address]: 'Alice', [bob.address]: 'Bob' };

function pay(from, to, amount, nonce) {
  return from.signTransaction(from.createTransaction(to.address, amount, { nonce, timestamp: 1000 }));
}

/** Two UNCONNECTED nodes (so their chains can differ) + an API over both. */
async function setup(t, { staticDir = null } = {}) {
  const a = new Node({ id: 'a', allocation: ALLOCATION });
  const b = new Node({ id: 'b', allocation: ALLOCATION });
  const api = new ExplorerApi({ nodes: [a, b], addressLabels: LABELS, staticDir });
  t.after(async () => {
    await api.stop();
    await Promise.all([a.stop(), b.stop()]);
  });
  await api.start();
  const get = async (pathname) => {
    const res = await fetch(`${api.url}${pathname}`);
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, headers: res.headers, body, text };
  };
  return { a, b, api, get };
}

/** Raw HTTP request, for things fetch() won't let us do (custom Host, methods with bodies). */
function rawRequest(api, { method = 'GET', path: p = '/api/health', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: api.port, method, path: p, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------- Basic responses ----------

test('health and node list', TIMEOUT, async (t) => {
  const { get } = await setup(t);
  assert.deepEqual((await get('/api/health')).body, { ok: true, nodes: 2 });
  const { body } = await get('/api/nodes');
  assert.deepEqual(body.nodes.map((n) => n.id), ['a', 'b']);
});

test('JSON responses carry safety headers', TIMEOUT, async (t) => {
  const { get } = await setup(t);
  const { headers } = await get('/api/health');
  assert.match(headers.get('content-type'), /application\/json/);
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('cache-control'), 'no-store');
  assert.equal(headers.get('access-control-allow-origin'), null); // no CORS: same-origin only
});

test('node summary reports chain, consensus, and supply', TIMEOUT, async (t) => {
  const { a, get } = await setup(t);
  a.mineBlock([pay(alice, bob, 10, 0)], 1000);
  const { status, body } = await get('/api/nodes/a');
  assert.equal(status, 200);
  assert.equal(body.id, 'a');
  assert.equal(body.height, 1);
  assert.equal(body.tipHash, a.tipHash);
  assert.equal(body.difficulty, 2);
  assert.equal(body.work, '256'); // BigInt sent as a string
  assert.deepEqual(body.validation, { valid: true });
  assert.equal(body.totalSupply, 150);
  assert.match(body.unit, /fictional/);
  assert.deepEqual(body.recentBlocks.map((b) => b.height), [1, 0]);
});

test('status endpoint reports validation and consensus rules', TIMEOUT, async (t) => {
  const { get } = await setup(t);
  const { body } = await get('/api/nodes/a/status');
  assert.deepEqual(body.validation, { valid: true });
  assert.equal(body.consensus.difficulty, 2);
  assert.match(body.consensus.rule, /proof-of-work/);
});

// ---------- Blocks ----------

test('blocks list: newest first, genesis flagged, transaction counts', TIMEOUT, async (t) => {
  const { a, get } = await setup(t);
  a.mineBlock([pay(alice, bob, 10, 0), pay(bob, alice, 1, 0)], 1000);
  a.mineBlock([pay(alice, bob, 5, 1)], 2000);
  const { body } = await get('/api/nodes/a/blocks');
  assert.equal(body.total, 3);
  assert.deepEqual(body.blocks.map((b) => [b.height, b.isGenesis, b.transactionCount]), [
    [2, false, 1],
    [1, false, 2],
    [0, true, 0],
  ]);
  assert.equal(body.blocks[0].previousHash, body.blocks[1].hash);
  assert.equal(body.blocks[0].confirmations, 1);
  assert.equal(body.blocks[2].confirmations, 3);
});

test('blocks list pagination and limits', TIMEOUT, async (t) => {
  const { a, get } = await setup(t);
  for (let i = 0; i < 3; i++) a.mineBlock([pay(alice, bob, 1, i)], 1000 + i);
  const page = (await get('/api/nodes/a/blocks?offset=1&limit=2')).body;
  assert.deepEqual(page.blocks.map((b) => b.height), [2, 1]);
  for (const query of ['limit=0', 'limit=101', 'limit=abc', 'limit=-1', 'offset=1.5', 'limit=1e2']) {
    const { status, body } = await get(`/api/nodes/a/blocks?${query}`);
    assert.equal(status, 400, query);
    assert.ok(body.error);
  }
});

test('block detail by height and by hash', TIMEOUT, async (t) => {
  const { a, get } = await setup(t);
  a.mineBlock([pay(alice, bob, 10, 0)], 1000);
  const byHeight = (await get('/api/nodes/a/blocks/1')).body;
  const byHash = (await get(`/api/nodes/a/blocks/${a.tipHash}`)).body;
  assert.deepEqual(byHeight, byHash);
  assert.equal(byHeight.meetsDifficulty, true);
  assert.equal(byHeight.transactions.length, 1);
  const [tx] = byHeight.transactions;
  assert.equal(tx.status, 'confirmed');
  assert.equal(tx.senderLabel, 'Alice');
  assert.equal(tx.recipientLabel, 'Bob');
  assert.equal(tx.sender, alice.address); // real address kept alongside the label
  assert.equal(tx.signatureValid, true);
  assert.equal(tx.blockHeight, 1);
});

test('genesis detail shows the allocation with labels', TIMEOUT, async (t) => {
  const { get } = await setup(t);
  const { body } = await get('/api/nodes/a/blocks/0');
  assert.equal(body.isGenesis, true);
  assert.equal(body.transactions, undefined);
  assert.deepEqual(
    body.allocation.map((x) => [x.label, x.amount]).sort(),
    [['Alice', 100], ['Bob', 50]]
  );
});

test('unknown and malformed block references', TIMEOUT, async (t) => {
  const { get } = await setup(t);
  assert.equal((await get('/api/nodes/a/blocks/5')).status, 404);
  assert.equal((await get(`/api/nodes/a/blocks/${'f'.repeat(64)}`)).status, 404);
  for (const ref of ['abc', '-1', '01', '1.0', 'F'.repeat(64), '9'.repeat(12)]) {
    assert.equal((await get(`/api/nodes/a/blocks/${ref}`)).status, 400, ref);
  }
});

// ---------- Transactions & balances ----------

test('transactions: confirmed only, newest first; pending is a separate endpoint', TIMEOUT, async (t) => {
  const { a, get } = await setup(t);
  a.mineBlock([pay(alice, bob, 10, 0)], 1000);
  a.mineBlock([pay(bob, alice, 4, 0), pay(alice, bob, 2, 1)], 2000);
  const { body } = await get('/api/nodes/a/transactions');
  assert.equal(body.total, 3);
  assert.deepEqual(body.transactions.map((x) => [x.blockHeight, x.amount]), [[2, 2], [2, 4], [1, 10]]);
  assert.ok(body.transactions.every((x) => x.status === 'confirmed' && x.signatureValid));
  // Milestone 8: a mempool exists now, but confirmed and pending stay separate.
  assert.deepEqual(
    [body.pending.supported, body.pending.count],
    [true, 0]
  );
  assert.match(body.pending.note, /\/api\/nodes\/a\/mempool/);
  assert.equal(body.transactions[2].nonce, 0);
  assert.equal(body.transactions[2].confirmations, 2);
});

test('balances: every known account, labels, and conservation', TIMEOUT, async (t) => {
  const { a, get } = await setup(t);
  const carol = new Wallet(); // unlabelled recipient
  a.mineBlock([pay(alice, carol, 30, 0)], 1000);
  const { body } = await get('/api/nodes/a/balances');
  assert.match(body.unit, /fictional/);
  const byAddress = Object.fromEntries(body.accounts.map((x) => [x.address, x]));
  assert.deepEqual(byAddress[alice.address], { address: alice.address, balance: 70, nextNonce: 1, label: 'Alice' });
  assert.equal(byAddress[bob.address].balance, 50);
  assert.equal(byAddress[carol.address].label, null);
  assert.equal(body.accounts.reduce((s, x) => s + x.balance, 0), body.totalSupply);
});

test('peers endpoint', TIMEOUT, async (t) => {
  const { a, b, get } = await setup(t);
  await Promise.all([a.start(), b.start()]);
  await a.connect(b.port);
  assert.deepEqual((await get('/api/nodes/a/peers')).body, { nodeId: 'a', peers: ['b'] });
});

// ---------- Multi-node independence & forks ----------

test('each node is reported from its own independent ledger', TIMEOUT, async (t) => {
  const { a, get } = await setup(t);
  a.mineBlock([pay(alice, bob, 10, 0)], 1000);
  assert.equal((await get('/api/nodes/a')).body.height, 1);
  assert.equal((await get('/api/nodes/b')).body.height, 0);
  assert.equal((await get('/api/nodes/b/blocks/1')).status, 404);
  const balances = (await get('/api/nodes/b/balances')).body.accounts;
  assert.equal(balances.find((x) => x.address === alice.address).balance, 100);
});

test('network view highlights forks and recovers after sync', TIMEOUT, async (t) => {
  const { a, b, get } = await setup(t);
  a.mineBlock([pay(alice, bob, 10, 0)], 1000);
  a.mineBlock([pay(alice, bob, 1, 1)], 2000);
  b.mineBlock([pay(bob, alice, 7, 0)], 1500);

  let net = (await get('/api/network')).body;
  assert.equal(net.inSync, false);
  assert.equal(net.distinctTips, 2);
  assert.equal(net.commonHeight, 0); // they only share genesis
  assert.equal(net.bestHeight, 2);
  assert.deepEqual(net.nodes.map((n) => [n.id, n.height, n.work]), [['a', 2, '512'], ['b', 1, '256']]);
  assert.equal(net.nodes[0].recent.at(-1).hash, a.tipHash);

  b.receiveChain(a.ledger.exportBlocks()); // b reorganizes onto a's chain
  net = (await get('/api/network')).body;
  assert.equal(net.inSync, true);
  assert.equal(net.commonHeight, 2);
});

test('a block reorganized away returns 404 by hash', TIMEOUT, async (t) => {
  const { a, b, get } = await setup(t);
  b.mineBlock([pay(bob, alice, 7, 0)], 1500);
  const orphanHash = b.tipHash;
  assert.equal((await get(`/api/nodes/b/blocks/${orphanHash}`)).status, 200);
  a.mineBlock([pay(alice, bob, 10, 0)], 1000);
  a.mineBlock([pay(alice, bob, 1, 1)], 2000);
  b.receiveChain(a.ledger.exportBlocks());
  assert.equal((await get(`/api/nodes/b/blocks/${orphanHash}`)).status, 404);
});

// ---------- Malformed input & safety ----------

test('unknown nodes and routes', TIMEOUT, async (t) => {
  const { get } = await setup(t);
  assert.equal((await get('/api/nodes/zzz')).status, 404);
  assert.equal((await get('/api/nodes/bad%20id')).status, 400);
  assert.equal((await get('/api/nodes/a/wallets')).status, 404); // (mempool exists since Milestone 8)
  assert.equal((await get('/api/nodes/a/mempool/x')).status, 404);
  assert.equal((await get('/api/nodes/a/blocks/1/extra')).status, 404);
  assert.equal((await get('/api/whatever')).status, 404);
  assert.equal((await get('/api')).status, 404);
});

test('the API is read-only: other methods are refused', TIMEOUT, async (t) => {
  const { a, api } = await setup(t);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await rawRequest(api, { method, path: '/api/nodes/a/blocks' });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.allow, 'GET');
  }
  assert.equal(a.height, 0);
});

test('request bodies, long URLs, and foreign Host headers are rejected', TIMEOUT, async (t) => {
  const { api } = await setup(t);
  const withBody = await rawRequest(api, { headers: { 'Content-Length': '5' }, body: 'hello' });
  assert.equal(withBody.status, 413);
  const long = await rawRequest(api, { path: `/api/health?x=${'a'.repeat(3000)}` });
  assert.equal(long.status, 414);
  const rebinding = await rawRequest(api, { headers: { Host: 'evil.example:80' } });
  assert.equal(rebinding.status, 403);
  const localhost = await rawRequest(api, { headers: { Host: `localhost:${api.port}` } });
  assert.equal(localhost.status, 200);
});

test('no private keys anywhere in the API', TIMEOUT, async (t) => {
  const { a, b, get } = await setup(t);
  a.mineBlock([pay(alice, bob, 10, 0)], 1000);
  b.receiveChain(a.ledger.exportBlocks());
  a.submitTransaction(pay(alice, bob, 1, 1)); // so pending views have content
  const paths = [
    '/api/network', '/api/nodes', '/api/nodes/a', '/api/nodes/a/status', '/api/nodes/a/blocks',
    '/api/nodes/a/blocks/0', '/api/nodes/a/blocks/1', '/api/nodes/a/transactions',
    '/api/nodes/a/balances', '/api/nodes/a/peers', '/api/nodes/a/mempool', '/api/mempool',
  ];
  for (const p of paths) {
    const { status, text } = await get(p);
    assert.equal(status, 200, p);
    assert.doesNotMatch(text, /private/i, p);
    assert.doesNotMatch(text, /BEGIN [A-Z ]*KEY/, p);
    // Ed25519 PRIVATE keys in DER start with this prefix; public keys start with 302a3005.
    assert.doesNotMatch(text, /302e020100300506032b6570/, p);
  }
});

// ---------- Pending transactions (Milestone 8) ----------

test('node mempool endpoint lists that node\'s pending txs with labels and source', TIMEOUT, async (t) => {
  const { a, get } = await setup(t);
  const tx = pay(alice, bob, 10, 0);
  a.submitTransaction(tx);
  const { status, body } = await get('/api/nodes/a/mempool');
  assert.equal(status, 200);
  assert.equal(body.count, 1);
  assert.deepEqual(body.limits, { maxSize: 500, maxPerSender: 25, maxTxBytes: 2048 });
  const [p] = body.transactions;
  assert.equal(p.status, 'pending');
  assert.equal(p.id.length, 64);
  assert.deepEqual([p.senderLabel, p.recipientLabel, p.amount, p.nonce, p.source], ['Alice', 'Bob', 10, 0, 'local']);
  assert.equal(p.sender, alice.address);
  assert.equal(p.signatureValid, true);
  assert.equal((await get('/api/nodes/b/mempool')).body.count, 0); // b's pool is its own
});

test('summary and network views report pending counts per node', TIMEOUT, async (t) => {
  const { a, get } = await setup(t);
  a.submitTransaction(pay(alice, bob, 10, 0));
  assert.equal((await get('/api/nodes/a')).body.pendingCount, 1);
  const net = (await get('/api/network')).body;
  assert.deepEqual(net.nodes.map((n) => [n.id, n.pendingCount]), [['a', 1], ['b', 0]]);
});

test('network mempool shows each node\'s view: pending → confirmed, unknown elsewhere', TIMEOUT, async (t) => {
  const { a, b, get } = await setup(t);
  const tx = pay(alice, bob, 10, 0);
  a.submitTransaction(tx);

  let view = (await get('/api/mempool')).body;
  assert.equal(view.inSync, false);
  assert.deepEqual(view.nodes, [{ id: 'a', pendingCount: 1, missing: 0 }, { id: 'b', pendingCount: 0, missing: 1 }]);
  let [row] = view.transactions;
  assert.deepEqual(row.statusByNode, { a: { status: 'pending', source: 'local' }, b: { status: 'unknown' } });
  assert.deepEqual([row.pendingOn, row.confirmedOn, row.unknownOn], [1, 0, 1]);

  a.mineFromMempool(); // a confirms it; b still hasn't heard of it
  view = (await get('/api/mempool')).body;
  [row] = view.transactions;
  assert.deepEqual(row.statusByNode, { a: { status: 'confirmed', blockHeight: 1 }, b: { status: 'unknown' } });
  assert.equal(view.inSync, true); // both pending sets are empty now

  b.receiveChain(a.ledger.exportBlocks());
  [row] = (await get('/api/mempool')).body.transactions;
  assert.equal(row.confirmedOn, 2);
});

test('the explorer API cannot submit or mine: no write route exists', TIMEOUT, async (t) => {
  const { a, api } = await setup(t);
  for (const p of ['/api/nodes/a/mempool', '/api/mempool', '/api/nodes/a/transactions']) {
    const res = await rawRequest(api, { method: 'POST', path: p, headers: { 'Content-Type': 'application/json' } });
    assert.equal(res.status, 405, p);
  }
  assert.equal(a.mempool.size, 0);
});

test('the API is bound to 127.0.0.1 by default', TIMEOUT, async (t) => {
  const { api } = await setup(t);
  assert.match(api.url, /^http:\/\/127\.0\.0\.1:\d+$/);
});

// ---------- Static frontend ----------

test('serves the built frontend and refuses path traversal', TIMEOUT, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'minichain-dist-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'assets'));
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>MiniChain</title>');
  await writeFile(path.join(dir, 'assets', 'app.js'), 'console.log(1)');

  const { get } = await setup(t, { staticDir: dir });
  const index = await get('/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match((await get('/assets/app.js')).headers.get('content-type'), /javascript/);
  assert.match((await get('/blocks')).text, /MiniChain/); // app route → index.html
  assert.equal((await get('/missing.js')).status, 404);
  for (const p of ['/..%2fpackage.json', '/%2e%2e/%2e%2e/etc/passwd', '/assets/..%2f..%2fsecret.txt']) {
    const res = await get(p);
    assert.ok([400, 404].includes(res.status) || /MiniChain/.test(res.text), p);
    assert.doesNotMatch(res.text, /"name": "minichain"|root:/, p);
  }
  assert.equal((await get('/%E0%A4%A')).status, 400); // malformed percent-encoding
});

test('without a built frontend, non-API paths explain how to build it', TIMEOUT, async (t) => {
  const { get } = await setup(t);
  const res = await get('/');
  assert.equal(res.status, 503);
  assert.match(res.text, /explorer:build/);
});

// ---------- Contracts (Milestone 9) ----------

const escrow = (opts = {}) => {
  const { amount = 30, deposit = amount, unlockHeight = 2, expiryHeight = 6, nonce = 0 } = opts;
  return alice.signTransaction(alice.createEscrowDeploy(
    { beneficiary: bob.address, amount, deposit, unlockHeight, expiryHeight }, { nonce, timestamp: 1000 }));
};
const contractCall = (w, id, op, amount, nonce) =>
  w.signTransaction(w.createContractCall(id, op, amount, { nonce, timestamp: 1000 }));

test('contracts list: confirmed contracts per node, with parties, amounts, status and phase', TIMEOUT, async (t) => {
  const { a, get } = await setup(t);
  assert.deepEqual((await get('/api/nodes/a/contracts')).body.contracts, []);
  const dep = escrow({ unlockHeight: 3, expiryHeight: 6 });
  a.mineBlock([dep], 1000); // #1
  const { body } = await get('/api/nodes/a/contracts');
  assert.deepEqual([body.count, body.limit, body.nextHeight], [1, 100, 2]);
  const [c] = body.contracts;
  assert.equal(c.id, dep.recipient);
  assert.deepEqual(
    [c.type, c.creatorLabel, c.beneficiaryLabel, c.amount, c.balance, c.status, c.phase, c.unlockHeight, c.expiryHeight, c.deployedAt],
    ['Timelock escrow', 'Alice', 'Bob', 30, 30, 'funded', 'locked', 3, 6, 1]
  );
  assert.equal(c.creator, alice.address);
  assert.equal((await get('/api/nodes/b/contracts')).body.count, 0); // b's chain is its own
  assert.equal((await get('/api/nodes/a')).body.contractCount, 1);
});

test('contract detail: activity with coin flow, pending calls, and status after a claim', TIMEOUT, async (t) => {
  const { a, get } = await setup(t);
  const dep = escrow({ unlockHeight: 2, expiryHeight: 6 });
  a.mineBlock([dep], 1000); // #1 → next block #2 is claimable
  const claim = contractCall(bob, dep.recipient, 'claim', 30, 0);
  assert.equal(a.submitTransaction(claim).status, 'accepted');

  let { status, body } = await get(`/api/nodes/a/contracts/${dep.recipient}`);
  assert.equal(status, 200);
  assert.equal(body.phase, 'claimable');
  assert.equal(body.pendingOps, 1);
  assert.deepEqual(body.pending.map((p) => [p.kind, p.status, p.flow.fromLabel, p.flow.toLabel]), [['claim', 'pending', 'Escrow contract', 'Bob']]);
  assert.deepEqual(body.activity.map((x) => [x.kind, x.blockHeight, x.flow.fromLabel, x.flow.toLabel]), [['deploy', 1, 'Alice', 'Escrow contract']]);
  assert.equal(body.activity[0].call.params.beneficiary, bob.address);

  a.mineFromMempool(); // #2 claims it
  ({ body } = await get(`/api/nodes/a/contracts/${dep.recipient}`));
  assert.deepEqual([body.status, body.phase, body.balance, body.updatedAt], ['claimed', 'claimed', 0, 2]);
  assert.deepEqual(body.activity.map((x) => x.kind), ['claim', 'deploy']);
  assert.deepEqual(body.pending, []);
});

test('transactions and mempool views label contract calls by kind', TIMEOUT, async (t) => {
  const { a, get } = await setup(t);
  a.mineBlock([pay(alice, bob, 1, 0)], 1000);
  a.submitTransaction(escrow({ nonce: 1, unlockHeight: 4, expiryHeight: 9 }));
  const txs = (await get('/api/nodes/a/transactions')).body.transactions;
  assert.equal(txs[0].kind, 'transfer');
  assert.equal(txs[0].contractId, null);
  const pending = (await get('/api/nodes/a/mempool')).body.transactions;
  assert.equal(pending[0].kind, 'deploy');
  assert.match(pending[0].contractId, /^CT[0-9a-f]{40}$/);
});

test('balances report coins locked in contracts so the totals still add up', TIMEOUT, async (t) => {
  const { a, get } = await setup(t);
  a.mineBlock([escrow({ amount: 40, deposit: 25 })], 1000);
  const { body } = await get('/api/nodes/a/balances');
  assert.equal(body.lockedInContracts, 25);
  assert.equal(body.accounts.reduce((s, x) => s + x.balance, 0) + body.lockedInContracts, body.totalSupply);
});

test('contract endpoints: unknown, malformed, and pending-only contracts', TIMEOUT, async (t) => {
  const { a, get } = await setup(t);
  assert.equal((await get(`/api/nodes/a/contracts/CT${'0'.repeat(40)}`)).status, 404);
  for (const bad of ['abc', `CT${'G'.repeat(40)}`, `MC${'0'.repeat(40)}`, `CT${'0'.repeat(39)}`]) {
    assert.equal((await get(`/api/nodes/a/contracts/${bad}`)).status, 400, bad);
  }
  const dep = escrow();
  a.submitTransaction(dep);
  const res = await get(`/api/nodes/a/contracts/${dep.recipient}`);
  assert.equal(res.status, 404);
  assert.match(res.body.error, /deployment is pending/);
  assert.equal((await get(`/api/nodes/a/contracts/${dep.recipient}/x`)).status, 404);
});

test('contract endpoints are read-only and leak no private keys', TIMEOUT, async (t) => {
  const { a, api, get } = await setup(t);
  const dep = escrow();
  a.mineBlock([dep], 1000);
  a.submitTransaction(contractCall(bob, dep.recipient, 'claim', 30, 0));
  for (const p of ['/api/nodes/a/contracts', `/api/nodes/a/contracts/${dep.recipient}`]) {
    const { status, text } = await get(p);
    assert.equal(status, 200);
    assert.doesNotMatch(text, /private/i);
    assert.doesNotMatch(text, /302e020100300506032b6570/);
    const post = await rawRequest(api, { method: 'POST', path: p });
    assert.equal(post.status, 405);
  }
  assert.equal(a.ledger.getContract(dep.recipient).status, 'funded'); // nothing changed
});
