/**
 * Mempool inside a Node: mining from it, keeping it consistent with the chain,
 * and gossiping pending transactions between real localhost TCP nodes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { Wallet } from '../src/wallet.js';
import { Ledger } from '../src/ledger.js';
import { Node } from '../src/node.js';
import { transactionId } from '../src/consensus.js';

const TIMEOUT = { timeout: 15_000 };
const alice = new Wallet();
const bob = new Wallet();
const charlie = new Wallet();
const ALLOCATION = [
  { address: alice.address, amount: 100 },
  { address: bob.address, amount: 100 },
  { address: charlie.address, amount: 100 },
];

function pay(from, to, amount, nonce, timestamp = 1000) {
  return from.signTransaction(from.createTransaction(to.address, amount, { nonce, timestamp }));
}
const idOf = (tx) => transactionId(tx.toJSON());
const pendingIds = (node) => node.getPendingTransactions().map((e) => e.id);
const balances = (node) => [alice, bob, charlie].map((w) => node.getBalance(w.address));

const makeNode = (id, options = {}) =>
  new Node({ id, allocation: ALLOCATION, requestTimeoutMs: 2000, ...options });

/** Wait for an event (optionally one matching `filter`), failing after 5 s. */
function waitFor(emitter, event, filter = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, 5000);
    const handler = (payload) => {
      if (!filter(payload)) return;
      clearTimeout(timer);
      emitter.off(event, handler);
      resolve(payload);
    };
    emitter.on(event, handler);
  });
}

async function startNodes(t, ids, options) {
  const nodes = ids.map((id) => makeNode(id, options));
  t.after(() => Promise.all(nodes.map((n) => n.stop())));
  await Promise.all(nodes.map((n) => n.start()));
  return nodes;
}

/** Connect `from` → `to` and wait for BOTH sides' mempool exchange to finish. */
async function connectAndExchange(from, to) {
  const done = Promise.all([
    waitFor(from, 'mempoolSynced', (e) => e.peerId === to.id),
    waitFor(to, 'mempoolSynced', (e) => e.peerId === from.id),
  ]);
  await from.connect(to.port);
  return done;
}

/** Valid ledger built elsewhere (to hand to receiveChain). */
function ledgerWith(blocks) {
  const ledger = new Ledger(ALLOCATION, 2);
  blocks.forEach((txs, i) => ledger.addBlock(txs, 5000 + i));
  return ledger;
}

// ---------- Submitting & mining (single node) ----------

test('submitTransaction admits a valid tx and reports it', () => {
  const node = makeNode('n');
  const events = [];
  node.on('txAccepted', (e) => events.push(e));
  const tx = pay(alice, bob, 10, 0);
  assert.deepEqual(node.submitTransaction(tx), { status: 'accepted', id: idOf(tx) });
  assert.deepEqual(pendingIds(node), [idOf(tx)]);
  assert.equal(events.length, 1);
  assert.equal(node.getPendingTransactions()[0].source, 'local');
  assert.equal(node.height, 0); // pending ≠ mined
});

test('mineFromMempool mines pending txs in deterministic order and clears them', () => {
  const node = makeNode('n');
  const txs = [pay(bob, charlie, 5, 0), pay(alice, bob, 10, 0), pay(alice, charlie, 1, 1)];
  for (const tx of txs) node.submitTransaction(tx);
  const block = node.mineFromMempool();
  assert.equal(block.index, 1);
  const order = block.data.transactions.map((t) => [t.sender, t.nonce]);
  const expected = [...order].sort(([s1, n1], [s2, n2]) => (s1 === s2 ? n1 - n2 : s1 < s2 ? -1 : 1));
  assert.deepEqual(order, expected);
  assert.equal(node.mempool.size, 0);
  assert.deepEqual(balances(node), [89, 105, 106]);
});

test('a tx that is already confirmed is "known", not rejected (late relays are normal)', () => {
  const node = makeNode('n');
  const tx = pay(alice, bob, 10, 0);
  node.mineBlock([tx], 1000);
  const rejected = [];
  node.on('txRejected', (e) => rejected.push(e));
  assert.deepEqual(node.submitTransaction(tx), { status: 'known', id: idOf(tx), confirmed: true });
  assert.equal(rejected.length, 0);
  assert.equal(node.mempool.size, 0);
  // A DIFFERENT tx reusing that nonce is still rejected (it's a replay, not old news).
  assert.match(node.submitTransaction(pay(alice, charlie, 1, 0)).reason, /Nonce 0 already used/);
});

test('mineFromMempool returns null when nothing is pending', () => {
  assert.equal(makeNode('n').mineFromMempool(), null);
});

test('mineFromMempool respects the per-block limit; the rest stay pending', () => {
  const node = makeNode('n', { maxBlockTransactions: 2 });
  for (let n = 0; n < 3; n++) node.submitTransaction(pay(alice, bob, 1, n));
  assert.equal(node.mineFromMempool().data.transactions.length, 2);
  assert.equal(node.mempool.size, 1);
  assert.equal(node.getPendingTransactions()[0].tx.nonce, 2); // still valid: next nonce
  assert.equal(node.mineFromMempool().data.transactions.length, 1);
});

test('the direct mineBlock interface still works and also clears matching pending txs', () => {
  const node = makeNode('n');
  const tx = pay(alice, bob, 10, 0);
  node.submitTransaction(tx);
  node.mineBlock([tx], 1000);
  assert.equal(node.mempool.size, 0);
});

test('a new block makes conflicting pending txs stale; they are dropped with a reason', () => {
  const node = makeNode('n');
  const pending = pay(alice, bob, 10, 0);
  const pendingNext = pay(alice, bob, 10, 1);
  node.submitTransaction(pending);
  node.submitTransaction(pendingNext);
  const changes = [];
  node.on('mempoolChanged', (c) => changes.push(c));
  node.mineBlock([pay(alice, charlie, 95, 0)], 1000); // different tx, SAME nonce 0
  assert.equal(node.mempool.size, 0);
  assert.equal(changes.length, 1);
  const reasons = changes[0].dropped.map((d) => d.reason);
  assert.match(reasons[0], /Nonce 0 already used/);
  assert.match(reasons[1], /Nonce 1 skips ahead|Insufficient/); // its predecessor is gone
});

test('a pending tx whose nonce gets used by a different confirmed tx is dropped', () => {
  const node = makeNode('n');
  node.submitTransaction(pay(bob, alice, 80, 0));
  // A peer's block contains a DIFFERENT Bob tx with the same nonce 0.
  node.receiveChain(ledgerWith([[pay(bob, charlie, 90, 0)]]).exportBlocks());
  assert.equal(node.mempool.size, 0);
});

test('a pending tx that became unaffordable is dropped when the chain moves on', () => {
  const node = makeNode('n');
  // Pending: Bob → Alice 50 (nonce 0), Bob → Alice 40 (nonce 1). Bob has 100: fine.
  node.submitTransaction(pay(bob, alice, 50, 0));
  node.submitTransaction(pay(bob, alice, 40, 1));
  const changes = [];
  node.on('mempoolChanged', (c) => changes.push(c));
  // The adopted chain contains a DIFFERENT nonce-0 tx: Bob → Charlie 90. Bob has 10 left.
  node.receiveChain(ledgerWith([[pay(bob, charlie, 90, 0)]]).exportBlocks());
  const reasons = changes[0].dropped.map((d) => d.reason);
  assert.match(reasons[0], /Nonce 0 already used/); // the 50 is stale
  assert.match(reasons[1], /Insufficient funds: balance 10, tried to send 40/); // nonce 1 is next now, but unaffordable
  assert.equal(node.mempool.size, 0);
});

test('adopting a block that contains our pending tx removes it as confirmed', () => {
  const node = makeNode('n');
  const tx = pay(alice, bob, 10, 0);
  node.submitTransaction(tx);
  const changes = [];
  node.on('mempoolChanged', (c) => changes.push(c));
  node.receiveChain(ledgerWith([[tx]]).exportBlocks());
  assert.equal(node.mempool.size, 0);
  assert.deepEqual(changes[0].confirmed, [idOf(tx)]);
  assert.deepEqual(changes[0].dropped, []);
});

// ---------- Reorganizations ----------

test('reorg: valid orphaned txs are recovered into the mempool', () => {
  const node = makeNode('n');
  const orphan = pay(charlie, alice, 20, 0);
  node.mineBlock([orphan], 1000);
  const winner = ledgerWith([[pay(alice, bob, 1, 0)], [pay(bob, alice, 1, 0)]]);
  const changes = [];
  node.on('mempoolChanged', (c) => changes.push(c));
  assert.equal(node.receiveChain(winner.exportBlocks()).adopted, true);
  assert.deepEqual(pendingIds(node), [idOf(orphan)]);
  assert.deepEqual(changes[0].recovered, [idOf(orphan)]);
  assert.equal(node.getPendingTransactions()[0].source, 'orphan-recovery');
  assert.equal(node.getBalance(charlie.address), 100); // pending, not confirmed
  node.mineFromMempool();
  assert.equal(node.getBalance(charlie.address), 80);
});

test('reorg: orphaned txs that conflict with the new chain are dropped, not recovered', () => {
  const node = makeNode('n');
  const orphan = pay(charlie, alice, 20, 0);
  node.mineBlock([orphan], 1000);
  const winner = ledgerWith([[pay(charlie, bob, 90, 0)], [pay(bob, alice, 1, 0)]]); // Charlie's nonce 0 used differently
  const changes = [];
  node.on('mempoolChanged', (c) => changes.push(c));
  node.receiveChain(winner.exportBlocks());
  assert.equal(node.mempool.size, 0);
  assert.equal(changes[0].dropped.length, 1);
  assert.equal(changes[0].dropped[0].wasRecovery, true);
  assert.match(changes[0].dropped[0].reason, /Nonce 0 already used/);
});

test('reorg: orphaned txs already confirmed on the new chain are not recovered', () => {
  const node = makeNode('n');
  const tx = pay(alice, bob, 5, 0);
  node.mineBlock([tx], 1000);
  const winner = new Ledger(ALLOCATION, 2);
  winner.addBlock([pay(charlie, bob, 1, 0)], 4000);
  winner.addBlock([tx], 4001); // same tx, different block
  node.receiveChain(winner.exportBlocks());
  assert.equal(node.mempool.size, 0);
});

test('reorg: orphan recovery is bounded', () => {
  const node = makeNode('n', { maxOrphanRecovery: 1 });
  node.mineBlock([pay(alice, charlie, 1, 0), pay(bob, charlie, 1, 0)], 1000);
  const changes = [];
  node.on('mempoolChanged', (c) => changes.push(c));
  node.receiveChain(ledgerWith([[pay(charlie, alice, 1, 0)], [pay(charlie, alice, 1, 1)]]).exportBlocks());
  assert.equal(changes[0].recovered.length, 1);
  assert.equal(changes[0].skippedRecovery, 1);
  assert.equal(node.mempool.size, 1);
});

test('reorg: still-valid pending txs survive; ones broken by the new chain are dropped', () => {
  const node = makeNode('n');
  node.submitTransaction(pay(alice, bob, 1, 0)); // still valid on the winner
  node.submitTransaction(pay(bob, charlie, 99, 0)); // the winner spends Bob's nonce 0
  node.receiveChain(ledgerWith([[pay(bob, alice, 50, 0)]]).exportBlocks());
  assert.deepEqual(node.getPendingTransactions().map((e) => e.tx.sender), [alice.address]);
});

// ---------- Gossip over TCP ----------

test('gossip: a tx submitted on one node reaches all three, relayed by the middle node', TIMEOUT, async (t) => {
  const [a, b, c] = await startNodes(t, ['a', 'b', 'c']);
  await connectAndExchange(a, b);
  await connectAndExchange(b, c); // a — b — c (a and c are NOT connected)
  const tx = pay(alice, bob, 10, 0);
  const reached = Promise.all([waitFor(b, 'txAccepted'), waitFor(c, 'txAccepted')]);
  a.submitTransaction(tx);
  const [atB, atC] = await reached;
  assert.equal(atB.source, 'a');
  assert.equal(atC.source, 'b');
  for (const node of [a, b, c]) assert.deepEqual(pendingIds(node), [idOf(tx)]);
  assert.equal(c.height, 0); // still pending everywhere
});

test('gossip: no loops in a fully connected triangle — each node relays once', TIMEOUT, async (t) => {
  const [a, b, c] = await startNodes(t, ['a', 'b', 'c']);
  await connectAndExchange(a, b);
  await connectAndExchange(a, c);
  await connectAndExchange(b, c);
  // In a triangle, b and c each get the tx twice: once new, once as a duplicate.
  const settled = Promise.all([
    waitFor(b, 'txAccepted'), waitFor(b, 'txKnown'),
    waitFor(c, 'txAccepted'), waitFor(c, 'txKnown'),
  ]);
  a.submitTransaction(pay(alice, bob, 10, 0));
  await settled;
  // A full round trip on every link flushes anything still in flight.
  await Promise.all([a.syncMempool(), b.syncMempool(), c.syncMempool()]);
  assert.equal(a.stats.txRelayed, 2); // to b and c
  assert.equal(b.stats.txRelayed, 1); // to c only (not back to a)
  assert.equal(c.stats.txRelayed, 1); // to b only
  assert.equal(b.stats.txReceived + c.stats.txReceived, 4);
  for (const node of [a, b, c]) assert.equal(node.mempool.size, 1);
});

test('a rejected tx is not relayed', TIMEOUT, async (t) => {
  const [a, b] = await startNodes(t, ['a', 'b']);
  await connectAndExchange(a, b);
  const result = a.submitTransaction(pay(charlie, bob, 500, 0)); // unaffordable
  assert.equal(result.status, 'rejected');
  await b.syncMempool(); // round trip: anything sent would have arrived by now
  assert.equal(b.stats.txReceived, 0);
  assert.equal(b.mempool.size, 0);
});

test('reconnection: pending txs are exchanged both ways; the chain is NOT synced', TIMEOUT, async (t) => {
  const [a, b, c] = await startNodes(t, ['a', 'b', 'c']);
  await connectAndExchange(a, b);
  // c is offline. a mines a block (c misses it) and both sides get pending txs.
  const bGotBlock = waitFor(b, 'chainUpdated');
  a.mineBlock([pay(bob, alice, 1, 0)]);
  await bGotBlock;
  const atB = waitFor(b, 'txAccepted');
  const fromA = pay(alice, bob, 10, 0);
  a.submitTransaction(fromA);
  await atB;
  const fromC = pay(charlie, alice, 7, 0);
  c.submitTransaction(fromC);

  await connectAndExchange(c, a); // reconnect
  const reachedB = waitFor(b, 'txAccepted', (e) => e.id === idOf(fromC));
  await reachedB; // a relays c's tx on to b

  for (const node of [a, b, c]) {
    assert.deepEqual(new Set(pendingIds(node)), new Set([idOf(fromA), idOf(fromC)]));
  }
  assert.equal(c.height, 0); // no automatic chain sync
  assert.equal(a.height, 1);
});

test('a confirmed block clears the tx from every node\'s mempool', TIMEOUT, async (t) => {
  const [a, b, c] = await startNodes(t, ['a', 'b', 'c']);
  await connectAndExchange(a, b);
  await connectAndExchange(b, c);
  const tx = pay(alice, charlie, 30, 0);
  const pendingEverywhere = Promise.all([waitFor(b, 'txAccepted'), waitFor(c, 'txAccepted')]);
  a.submitTransaction(tx);
  await pendingEverywhere;

  const confirmed = Promise.all([waitFor(a, 'chainUpdated'), waitFor(c, 'chainUpdated')]);
  b.mineFromMempool(); // the middle node mines it
  await confirmed;
  for (const node of [a, b, c]) {
    assert.equal(node.mempool.size, 0);
    assert.equal(node.getBalance(charlie.address), 130);
  }
});

test('partition: pending txs reach Charlie after he reconnects, then sync heals the fork', TIMEOUT, async (t) => {
  const [a, b, c] = await startNodes(t, ['a', 'b', 'c']);
  await connectAndExchange(a, b);
  await connectAndExchange(a, c);
  await Promise.all([waitFor(a, 'peerDisconnected'), c.disconnectAll()]);

  const tx = pay(alice, bob, 3, 0);
  a.submitTransaction(tx);
  assert.equal(c.mempool.size, 0); // partitioned
  a.mineBlock([pay(bob, alice, 1, 0)]);
  c.mineBlock([pay(charlie, bob, 1, 0)]); // competing block → fork (equal height)

  await connectAndExchange(c, a);
  assert.deepEqual(pendingIds(c), [idOf(tx)]); // pending tx arrived; valid on both branches
  assert.notEqual(c.tipHash, a.tipHash); // fork still there

  a.mineFromMempool(); // a pulls ahead; c hears NEW_BLOCK and adopts the longer chain
  await waitFor(c, 'chainUpdated', (e) => e.source === 'a');
  assert.equal(c.tipHash, a.tipHash);
  assert.equal(c.mempool.size, 1); // Charlie's orphaned tx is recovered (still valid)
  assert.equal(c.getPendingTransactions()[0].source, 'orphan-recovery');
});

// ---------- Untrusted peers (raw TCP) ----------

/** A bare TCP client that completes the handshake and can send raw lines. */
async function rawPeer(t, node, nodeId = 'mallory') {
  const socket = net.createConnection({ port: node.port, host: '127.0.0.1' });
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.setEncoding('utf8');
  const inbox = [];
  const waiters = [];
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const message = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      waiters.length ? waiters.shift()(message) : inbox.push(message);
    }
  });
  socket.on('error', () => {});
  const send = (message) => socket.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`);
  const next = () => new Promise((resolve, reject) => {
    if (inbox.length) return resolve(inbox.shift());
    const timer = setTimeout(() => reject(new Error('no message')), 5000);
    waiters.push((m) => { clearTimeout(timer); resolve(m); });
  });
  send({ type: 'HELLO', nodeId, ...node.consensusParams });
  assert.equal((await next()).type, 'HELLO_ACK');
  return { send, next, socket };
}

test('a peer sending a badly signed tx gets an ERROR; the tx is neither stored nor relayed', TIMEOUT, async (t) => {
  const [node, honest] = await startNodes(t, ['node', 'honest']);
  await connectAndExchange(honest, node);
  const evil = await rawPeer(t, node);
  const tx = pay(alice, bob, 10, 0).toJSON();
  tx.amount = 99; // breaks the signature
  evil.send({ type: 'NEW_TX', transaction: tx });
  assert.deepEqual(await evil.next(), { type: 'ERROR', message: 'Invalid transaction: Invalid signature' });
  assert.equal(node.mempool.size, 0);
  await honest.syncMempool();
  assert.equal(honest.stats.txReceived, 0);
});

test('an honest-but-stale tx (e.g. unaffordable) is rejected WITHOUT blaming the peer', TIMEOUT, async (t) => {
  const [node] = await startNodes(t, ['node']);
  const peer = await rawPeer(t, node);
  peer.send({ type: 'NEW_TX', transaction: pay(charlie, bob, 500, 0).toJSON() });
  peer.send({ type: 'GET_CHAIN', requestId: 1 });
  assert.equal((await peer.next()).type, 'CHAIN'); // no ERROR came first
  assert.equal(node.mempool.size, 0);
  assert.equal(node.stats.txRejected, 1);
});

test('oversized and malformed tx messages are rejected', TIMEOUT, async (t) => {
  const [node] = await startNodes(t, ['node']);
  const peer = await rawPeer(t, node);
  peer.send({ type: 'NEW_TX', transaction: { ...pay(alice, bob, 1, 0).toJSON(), signature: 'f'.repeat(5000) } });
  assert.match((await peer.next()).message, /exceeds 2048 bytes/);
  peer.send({ type: 'NEW_TX', transaction: [] });
  assert.equal((await peer.next()).message, 'NEW_TX: invalid transaction');
  assert.equal(node.mempool.size, 0);
});

test('a peer\'s mempool is not trusted: only valid txs from a MEMPOOL reply are admitted', TIMEOUT, async (t) => {
  const [node] = await startNodes(t, ['node']);
  const peer = await rawPeer(t, node);
  peer.send({ type: 'GET_MEMPOOL', requestId: 1 }); // we ask → node replies, then asks us back
  assert.deepEqual(await peer.next(), { type: 'MEMPOOL', requestId: 1, transactions: [] });
  const request = await peer.next();
  assert.equal(request.type, 'GET_MEMPOOL');

  const good = pay(alice, bob, 1, 0).toJSON();
  const forged = { ...pay(bob, alice, 1, 0).toJSON(), amount: 50 };
  const synced = waitFor(node, 'mempoolSynced');
  peer.send({ type: 'MEMPOOL', requestId: request.requestId, transactions: [forged, good, { junk: true }] });
  const counts = await synced;
  assert.deepEqual([counts.accepted, counts.rejected], [1, 2]);
  assert.deepEqual(node.getPendingTransactions().map((e) => e.tx), [good]);
  assert.equal((await peer.next()).message, 'Sent 2 invalid transaction(s)');
});

test('a MEMPOOL reply with too many transactions is a protocol error', TIMEOUT, async (t) => {
  const [node] = await startNodes(t, ['node']);
  const peer = await rawPeer(t, node);
  peer.send({ type: 'GET_MEMPOOL', requestId: 1 });
  await peer.next(); // our MEMPOOL reply
  const request = await peer.next();
  peer.send({ type: 'MEMPOOL', requestId: request.requestId, transactions: new Array(501).fill({}) });
  assert.equal((await peer.next()).message, 'MEMPOOL: invalid transactions');
  assert.equal(node.mempool.size, 0);
});

test('unsolicited MEMPOOL replies are rejected', TIMEOUT, async (t) => {
  const [node] = await startNodes(t, ['node']);
  const peer = await rawPeer(t, node);
  peer.send({ type: 'MEMPOOL', requestId: 42, transactions: [pay(alice, bob, 1, 0).toJSON()] });
  assert.equal((await peer.next()).message, 'Unexpected MEMPOOL reply');
  assert.equal(node.mempool.size, 0);
});
