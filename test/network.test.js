/**
 * Real TCP networking between nodes on 127.0.0.1 (random free ports).
 *
 * No sleeps: every wait is for a specific event, with a timeout so a bug
 * fails the test instead of hanging it. Every node is stopped afterwards.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { Wallet } from '../src/wallet.js';
import { Blockchain } from '../src/blockchain.js';
import { Ledger } from '../src/ledger.js';
import { Node } from '../src/node.js';
import { MAX_MESSAGE_BYTES } from '../src/protocol.js';

const TIMEOUT = { timeout: 10_000 };

const alice = new Wallet();
const bob = new Wallet();
const charlie = new Wallet();
const ALLOCATION = [
  { address: alice.address, amount: 100 },
  { address: bob.address, amount: 100 },
  { address: charlie.address, amount: 100 },
];

function pay(from, to, amount, nonce) {
  return from.signTransaction(from.createTransaction(to.address, amount, { nonce, timestamp: 1000 }));
}

/** Wait for one event, failing after 5 s instead of hanging. */
const waitFor = (emitter, event) => once(emitter, event, { signal: AbortSignal.timeout(5000) });

/** Fail a promise after 5 s instead of hanging. */
function withTimeout(promise, label) {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Timed out: ${label}`)), 5000).unref();
  });
  return Promise.race([promise, timeout]);
}

/** Start nodes and register cleanup with the test. */
async function startNodes(t, ids, options = {}) {
  const nodes = ids.map((id) => new Node({ id, allocation: ALLOCATION, requestTimeoutMs: 2000, ...options }));
  t.after(() => Promise.all(nodes.map((n) => n.stop())));
  await Promise.all(nodes.map((n) => n.start()));
  return nodes;
}

const balancesOf = (node) => [alice, bob, charlie].map((w) => node.getBalance(w.address));

/**
 * A bare TCP client for sending raw (possibly malformed) bytes.
 * next() resolves with the next message the node sends us.
 */
async function rawClient(t, port) {
  const socket = net.createConnection({ port, host: '127.0.0.1' });
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
  const closed = once(socket, 'close');
  return {
    send: (text) => socket.write(text),
    next: () => withTimeout(
      inbox.length ? Promise.resolve(inbox.shift()) : new Promise((r) => waiters.push(r)),
      'next message'
    ),
    get closed() {
      return withTimeout(closed, 'connection close');
    },
  };
}

// ---------- Connecting & disconnecting ----------

test('nodes connect: both sides see each other', TIMEOUT, async (t) => {
  const [a, b] = await startNodes(t, ['a', 'b']);
  const bSaw = waitFor(b, 'peerConnected');
  assert.equal(await a.connect(b.port), 'b');
  assert.deepEqual(await bSaw, ['a']);
  assert.deepEqual(a.peerIds, ['b']);
  assert.deepEqual(b.peerIds, ['a']);
});

test('disconnect removes the peer on both sides', TIMEOUT, async (t) => {
  const [a, b] = await startNodes(t, ['a', 'b']);
  await a.connect(b.port);
  const bSaw = waitFor(b, 'peerDisconnected');
  await a.disconnect('b');
  assert.deepEqual(await bSaw, ['a']);
  assert.deepEqual(a.peerIds, []);
  assert.deepEqual(b.peerIds, []);
});

test('a node cannot connect to itself or connect twice', TIMEOUT, async (t) => {
  const [a, b] = await startNodes(t, ['a', 'b']);
  await assert.rejects(a.connect(a.port), /Cannot connect to yourself/);
  await a.connect(b.port);
  await assert.rejects(a.connect(b.port), /Already connected/);
  assert.deepEqual(a.peerIds, ['b']);
});

test('nodes with a different genesis allocation refuse to connect', TIMEOUT, async (t) => {
  const [a] = await startNodes(t, ['a']);
  const other = new Node({ id: 'other', allocation: [{ address: alice.address, amount: 5 }] });
  t.after(() => other.stop());
  await other.start();
  await assert.rejects(other.connect(a.port), /Different genesis/);
  assert.deepEqual(a.peerIds, []);
});

test('nodes with a different difficulty refuse to connect', TIMEOUT, async (t) => {
  const [a] = await startNodes(t, ['a']);
  const [hard] = await startNodes(t, ['hard'], { difficulty: 3 });
  await assert.rejects(hard.connect(a.port), /Difficulty mismatch/);
  assert.deepEqual(a.peerIds, []);
});

test('connecting to a closed port fails cleanly', TIMEOUT, async (t) => {
  const [a, b] = await startNodes(t, ['a', 'b']);
  const port = b.port;
  await b.stop();
  await assert.rejects(a.connect(port));
});

// ---------- Propagation & sync ----------

test('a mined block propagates to a directly connected peer', TIMEOUT, async (t) => {
  const [a, b] = await startNodes(t, ['a', 'b']);
  await a.connect(b.port);
  const updated = waitFor(b, 'chainUpdated');
  a.mineBlock([pay(alice, bob, 10, 0)]);
  await updated;
  assert.equal(b.tipHash, a.tipHash);
  assert.deepEqual(balancesOf(b), [90, 110, 100]);
});

test('blocks are relayed across a line of nodes (a — b — c)', TIMEOUT, async (t) => {
  const [a, b, c] = await startNodes(t, ['a', 'b', 'c']);
  await a.connect(b.port);
  await b.connect(c.port);
  const cUpdated = waitFor(c, 'chainUpdated');
  a.mineBlock([pay(alice, charlie, 25, 0)]);
  await cUpdated; // c is not connected to a; b passed it on
  assert.equal(c.tipHash, a.tipHash);
  assert.equal(c.getBalance(charlie.address), 125);
});

test('a late-joining node catches up with sync()', TIMEOUT, async (t) => {
  const [a, late] = await startNodes(t, ['a', 'late']);
  a.mineBlock([pay(alice, bob, 1, 0)]);
  a.mineBlock([pay(alice, bob, 1, 1)]);
  a.mineBlock([pay(bob, charlie, 1, 0)]);
  await late.connect(a.port);
  const [result] = await late.sync();
  assert.equal(result.adopted, true);
  assert.equal(late.height, 3);
  assert.equal(late.tipHash, a.tipHash);
});

test('a node that is behind catches up when it hears about a newer block', TIMEOUT, async (t) => {
  const [a, b] = await startNodes(t, ['a', 'b']);
  a.mineBlock([pay(alice, bob, 1, 0)]); // b doesn't hear this one
  await a.connect(b.port);
  const updated = waitFor(b, 'chainUpdated');
  a.mineBlock([pay(alice, bob, 1, 1)]); // parent unknown to b → b requests the chain
  await updated;
  assert.equal(b.height, 2);
  assert.equal(b.tipHash, a.tipHash);
});

test('sync with a weaker peer keeps our chain', TIMEOUT, async (t) => {
  const [strong, weak] = await startNodes(t, ['strong', 'weak']);
  strong.mineBlock([pay(alice, bob, 1, 0)]);
  strong.mineBlock([pay(alice, bob, 1, 1)]);
  weak.mineBlock([pay(charlie, bob, 1, 0)]);
  const before = strong.tipHash;
  await strong.connect(weak.port);
  const [result] = await strong.sync();
  assert.equal(result.adopted, false);
  assert.match(result.reason, /Less work/);
  assert.equal(strong.tipHash, before);
});

test('sync with an equal-work peer keeps our chain', TIMEOUT, async (t) => {
  const [a, b] = await startNodes(t, ['a', 'b']);
  a.mineBlock([pay(alice, bob, 1, 0)]);
  b.mineBlock([pay(charlie, bob, 1, 0)]);
  const [aTip, bTip] = [a.tipHash, b.tipHash];
  await a.connect(b.port);
  assert.match((await a.sync())[0].reason, /Equal work/);
  assert.match((await b.sync())[0].reason, /Equal work/);
  assert.equal(a.tipHash, aTip);
  assert.equal(b.tipHash, bTip);
});

// ---------- Three-node convergence with a partition ----------

test('three nodes: partition, fork, reconnect, reorg, converge', TIMEOUT, async (t) => {
  const [a, b, c] = await startNodes(t, ['alice', 'bob', 'charlie']);
  await a.connect(b.port);
  await a.connect(c.port);
  await b.connect(c.port);
  assert.equal(new Set([a.tipHash, b.tipHash, c.tipHash]).size, 1); // all at genesis

  // Partition: Charlie goes offline.
  await Promise.all([waitFor(a, 'peerDisconnected'), waitFor(b, 'peerDisconnected'), c.disconnectAll()]);

  // Alice + Bob mine two blocks together.
  let bUpdated = waitFor(b, 'chainUpdated');
  a.mineBlock([pay(alice, bob, 10, 0)]);
  await bUpdated;
  const aUpdated = waitFor(a, 'chainUpdated');
  b.mineBlock([pay(bob, alice, 5, 0)]);
  await aUpdated;

  // Charlie mines one block alone: a fork.
  const orphan = pay(charlie, alice, 20, 0);
  c.mineBlock([orphan]);
  assert.notEqual(c.tipHash, a.tipHash);
  assert.equal(c.getBalance(charlie.address), 80);

  // Reconnect and sync.
  await c.connect(a.port);
  await c.connect(b.port);
  const reorg = waitFor(c, 'reorg');
  const results = await c.sync();
  assert.equal(results.filter((r) => r.adopted).length, 1); // second peer: "Already in sync"
  const [details] = await reorg;
  assert.deepEqual(details.orphanedTransactions, [orphan.toJSON()]);

  // Everyone agrees; Charlie's orphaned payment is no longer confirmed.
  for (const node of [a, b, c]) {
    assert.equal(node.tipHash, a.tipHash);
    assert.deepEqual(balancesOf(node), [95, 105, 100]);
  }

  // Charlie resubmits the orphaned transaction; it reaches everyone.
  const both = [waitFor(a, 'chainUpdated'), waitFor(b, 'chainUpdated')];
  c.mineBlock(details.orphanedTransactions);
  await Promise.all(both);
  for (const node of [a, b, c]) {
    assert.equal(node.height, 3);
    assert.deepEqual(balancesOf(node), [115, 105, 80]);
  }
});

// ---------- Malicious peers ----------

test('an honest node rejects an invalid chain from a peer and disconnects it', TIMEOUT, async (t) => {
  const [honest, evil] = await startNodes(t, ['honest', 'evil']);
  honest.mineBlock([pay(alice, bob, 1, 0)]);
  const before = honest.tipHash;

  // Evil builds a LONGER chain containing an unaffordable (but signed) payment.
  const forged = new Ledger(ALLOCATION, 2);
  for (let i = 0; i < 3; i++) {
    Blockchain.prototype.addBlock.call(forged, { transactions: [pay(charlie, bob, 1000 + i, i).toJSON()] });
  }
  evil.ledger = forged;

  await evil.connect(honest.port);
  const rejected = waitFor(honest, 'chainRejected');
  const dropped = waitFor(honest, 'peerDisconnected');
  evil.announceTip();
  const [{ reason }] = await rejected;
  assert.match(reason, /Insufficient funds/);
  await dropped;
  assert.equal(honest.tipHash, before);
  assert.deepEqual(honest.peerIds, []);
});

// ---------- Malformed network messages ----------

test('malformed messages get an ERROR reply and do not crash the node', TIMEOUT, async (t) => {
  const [node] = await startNodes(t, ['node']);
  const client = await rawClient(t, node.port);

  client.send('this is not json\n');
  assert.deepEqual(await client.next(), { type: 'ERROR', message: 'Invalid JSON' });

  client.send('{"type":"GET_CHAIN","requestId":1}\n'); // valid, but no handshake yet
  assert.deepEqual(await client.next(), { type: 'ERROR', message: 'Handshake required first' });

  // The node still works for well-behaved peers.
  const [friend] = await startNodes(t, ['friend']);
  assert.equal(await friend.connect(node.port), 'node');
});

test('three strikes and the peer is disconnected', TIMEOUT, async (t) => {
  const [node] = await startNodes(t, ['node']);
  const client = await rawClient(t, node.port);
  client.send('bad\n{"type":"NOPE"}\n[]\n');
  for (let i = 0; i < 3; i++) assert.equal((await client.next()).type, 'ERROR');
  await client.closed;
});

test('an oversized message closes the connection', TIMEOUT, async (t) => {
  const [node] = await startNodes(t, ['node']);
  const client = await rawClient(t, node.port);
  client.send('x'.repeat(MAX_MESSAGE_BYTES + 10)); // no newline: a never-ending "message"
  const reply = await client.next();
  assert.match(reply.message, /exceeds/);
  await client.closed;
});

test('handshake with the wrong genesis over raw TCP is refused', TIMEOUT, async (t) => {
  const [node] = await startNodes(t, ['node']);
  const client = await rawClient(t, node.port);
  client.send(JSON.stringify({ type: 'HELLO', nodeId: 'mallory', ...node.consensusParams, genesisHash: 'f'.repeat(64) }) + '\n');
  assert.match((await client.next()).message, /Different genesis/);
  await client.closed;
  assert.deepEqual(node.peerIds, []);
});

test('after the handshake, junk messages and unexpected replies are rejected', TIMEOUT, async (t) => {
  const [node] = await startNodes(t, ['node']);
  const client = await rawClient(t, node.port);
  client.send(JSON.stringify({ type: 'HELLO', nodeId: 'mallory', ...node.consensusParams }) + '\n');
  assert.equal((await client.next()).type, 'HELLO_ACK');

  client.send(JSON.stringify({ type: 'CHAIN', requestId: 99, blocks: [] }) + '\n');
  assert.deepEqual(await client.next(), { type: 'ERROR', message: 'Unexpected CHAIN reply' });

  // A malformed block that claims to extend our tip → invalid chain → disconnect.
  client.send(JSON.stringify({ type: 'NEW_BLOCK', block: { previousHash: node.tipHash, hash: 'x' } }) + '\n');
  assert.match((await client.next()).message, /Invalid chain rejected/);
  await client.closed;
  assert.equal(node.height, 0);
});
