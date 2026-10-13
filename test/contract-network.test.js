/**
 * Contracts in the mempool, across real TCP gossip, and through reorgs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { Wallet } from '../src/wallet.js';
import { Ledger } from '../src/ledger.js';
import { Mempool } from '../src/mempool.js';
import { Node } from '../src/node.js';
import { transactionId } from '../src/consensus.js';

const TIMEOUT = { timeout: 15_000 };
const alice = new Wallet();
const bob = new Wallet();
const carol = new Wallet();
const ALLOCATION = [
  { address: alice.address, amount: 100 },
  { address: bob.address, amount: 100 },
  { address: carol.address, amount: 100 },
];

const sign = (w, tx) => w.signTransaction(tx);
const deploy = ({ amount = 30, deposit = amount, unlockHeight = 3, expiryHeight = 8, nonce = 0 } = {}) =>
  sign(alice, alice.createEscrowDeploy({ beneficiary: bob.address, amount, deposit, unlockHeight, expiryHeight }, { nonce, timestamp: 1000 }));
const call = (w, id, op, amount, nonce) => sign(w, w.createContractCall(id, op, amount, { nonce, timestamp: 1000 }));
const transfer = (w, to, amount, nonce) => sign(w, w.createTransaction(to.address, amount, { nonce, timestamp: 1000 + nonce }));
const idOf = (tx) => transactionId(tx.toJSON());

const makeNode = (id, options = {}) => new Node({ id, allocation: ALLOCATION, requestTimeoutMs: 2000, ...options });

/** Mine filler blocks on `node` (Carol → Alice 1) until its next block has height `h`. */
function advanceTo(node, h) {
  while (node.height + 1 < h) {
    node.mineBlock([transfer(carol, alice, 1, node.ledger.getNextNonce(carol.address))]);
  }
}

function waitFor(emitter, event, filter = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { emitter.off(event, handler); reject(new Error(`Timed out waiting for ${event}`)); }, 5000);
    const handler = (p) => { if (filter(p)) { clearTimeout(timer); emitter.off(event, handler); resolve(p); } };
    emitter.on(event, handler);
  });
}

// ---------- Mempool admission ----------

test('mempool admits a valid deploy and checks its signature and schema', () => {
  const ledger = new Ledger(ALLOCATION, 1);
  const pool = new Mempool();
  assert.equal(pool.add(deploy(), ledger.getState()).status, 'accepted');
  const forged = deploy({ nonce: 1 }).toJSON();
  forged.contract.params.amount = 99; // breaks the derived ID and the signature
  const result = pool.add(forged, ledger.getState());
  assert.equal(result.status, 'rejected');
  assert.equal(result.fault, true); // provably bad: no honest node sends it
});

test('mempool checks timelocks at the NEXT block\'s height: early claims are rejected, not queued', () => {
  const node = makeNode('n');
  const dep = deploy({ unlockHeight: 3, expiryHeight: 8 });
  node.mineBlock([dep]); // height 1 → next block is #2
  const early = node.submitTransaction(call(bob, dep.recipient, 'claim', 30, 0));
  assert.equal(early.status, 'rejected');
  assert.equal(early.fault, false); // honest: it just isn't time yet
  assert.match(early.reason, /Too early: claimable from block #3, this is block #2/);
  advanceTo(node, 3);
  assert.equal(node.submitTransaction(call(bob, dep.recipient, 'claim', 30, 0)).status, 'accepted');
});

test('pending deposits reserve the creator\'s coins (deploy + transfer cannot overspend)', () => {
  const node = makeNode('n');
  assert.equal(node.submitTransaction(deploy({ amount: 80 })).status, 'accepted');
  const second = node.submitTransaction(transfer(alice, carol, 30, 1));
  assert.match(second.reason, /Insufficient funds: balance 20, tried to send 30 \(after reserving 1 pending transaction\)/);
});

test('the creator can queue deploy + fund together (same sender, consecutive nonces)', () => {
  const node = makeNode('n');
  const dep = deploy({ amount: 30, deposit: 10, unlockHeight: 4 });
  assert.equal(node.submitTransaction(dep).status, 'accepted');
  assert.equal(node.submitTransaction(call(alice, dep.recipient, 'fund', 20, 1)).status, 'accepted');
  assert.match(node.submitTransaction(call(alice, dep.recipient, 'fund', 1, 2)).reason, /already fully funded/);
  node.mineFromMempool();
  assert.equal(node.ledger.getContract(dep.recipient).status, 'funded');
  assert.equal(node.mempool.size, 0);
});

test('others cannot build on PENDING contract state (conservative, like pending incoming coins)', () => {
  const node = makeNode('n');
  const dep = deploy({ unlockHeight: 2 });
  node.submitTransaction(dep);
  assert.match(node.submitTransaction(call(bob, dep.recipient, 'claim', 30, 0)).reason, /Unknown contract/);
  const partial = deploy({ amount: 30, deposit: 10, unlockHeight: 3, nonce: 1 });
  node.mineFromMempool(); // confirms the first deploy
  node.mineBlock([partial]);
  assert.equal(node.submitTransaction(call(alice, partial.recipient, 'fund', 20, 2)).status, 'accepted');
  assert.equal(node.height + 1, 3); // the next block (#3) is at the unlock height
  // The completing fund is still only PENDING → for Bob, the escrow is not funded yet.
  assert.ok(node.getPendingTransactions().some((e) => e.tx.contract?.op === 'fund'));
  assert.match(node.submitTransaction(call(bob, partial.recipient, 'claim', 30, 0)).reason, /Insufficient funding: 10 of 30/);
});

test('nonce rules are shared: a contract call cannot reuse a transfer\'s pending nonce', () => {
  const node = makeNode('n');
  node.submitTransaction(transfer(alice, carol, 5, 0));
  assert.match(node.submitTransaction(deploy({ nonce: 0 })).reason, /same sender and nonce/);
  assert.match(node.submitTransaction(deploy({ nonce: 2 })).reason, /Nonce 2 skips ahead; expected 1/);
  assert.equal(node.submitTransaction(deploy({ nonce: 1 })).status, 'accepted');
});

test('pending claims are dropped when a new block closes their window', () => {
  const node = makeNode('n');
  const dep = deploy({ unlockHeight: 2, expiryHeight: 4 });
  node.mineBlock([dep]); // #1
  advanceTo(node, 3); // next block #3: claimable (3 < 4)
  assert.equal(node.submitTransaction(call(bob, dep.recipient, 'claim', 30, 0)).status, 'accepted');
  const changes = [];
  node.on('mempoolChanged', (c) => changes.push(c));
  node.mineBlock([transfer(carol, alice, 1, node.ledger.getNextNonce(carol.address))]); // #3, without the claim
  assert.equal(node.mempool.size, 0);
  assert.match(changes.at(-1).dropped[0].reason, /Claim window closed at block #4/);
});

test('a confirmed claim makes a second pending claim stale (no double claims)', () => {
  const node = makeNode('n');
  const dep = deploy({ unlockHeight: 2 });
  node.mineBlock([dep]);
  const claim = call(bob, dep.recipient, 'claim', 30, 0);
  node.submitTransaction(claim);
  node.mineFromMempool();
  assert.equal(node.ledger.getContract(dep.recipient).status, 'claimed');
  assert.match(node.submitTransaction(call(bob, dep.recipient, 'claim', 30, 1)).reason, /already claimed/);
  assert.deepEqual(node.submitTransaction(claim), { status: 'known', id: idOf(claim), confirmed: true });
});

test('mineFromMempool mixes transfers and contract calls from several senders', () => {
  const node = makeNode('n');
  const dep = deploy({ unlockHeight: 2, expiryHeight: 9 });
  node.mineBlock([dep]);
  node.submitTransaction(call(bob, dep.recipient, 'claim', 30, 0));
  node.submitTransaction(transfer(carol, bob, 5, 0));
  node.submitTransaction(deploy({ amount: 10, unlockHeight: 5, expiryHeight: 9, nonce: 1 }));
  const block = node.mineFromMempool();
  assert.equal(block.data.transactions.length, 3);
  assert.equal(node.ledger.getContracts().length, 2);
  assert.equal(node.getBalance(bob.address), 135);
});

// ---------- Reorganizations ----------

test('reorg: a claim on the abandoned branch is rolled back and recovered to the mempool', () => {
  const node = makeNode('n');
  const dep = deploy({ unlockHeight: 2, expiryHeight: 9 });
  const shared = new Ledger(ALLOCATION, 2);
  shared.addBlock([dep], 1000); // #1 on both branches
  node.receiveChain(shared.exportBlocks());

  const claim = call(bob, dep.recipient, 'claim', 30, 0);
  node.mineBlock([claim]); // #2 — only on node's branch
  assert.equal(node.ledger.getContract(dep.recipient).status, 'claimed');

  // A longer competing branch without the claim.
  shared.addBlock([transfer(carol, alice, 1, 0)], 2000);
  shared.addBlock([transfer(carol, alice, 1, 1)], 3000);
  assert.equal(node.receiveChain(shared.exportBlocks()).adopted, true);

  const c = node.ledger.getContract(dep.recipient);
  assert.deepEqual([c.status, c.balance], ['funded', 30]); // rolled back
  assert.equal(node.getBalance(bob.address), 100); // Bob's 30 are no longer confirmed
  assert.deepEqual(node.getPendingTransactions().map((e) => e.id), [idOf(claim)]); // still valid at #4 < 9
});

test('reorg: a deploy that no longer fits the new chain is dropped, and its contract disappears', () => {
  const node = makeNode('n');
  const dep = deploy({ unlockHeight: 2, expiryHeight: 9 });
  node.mineBlock([dep]); // #1 only on node's branch
  const other = new Ledger(ALLOCATION, 2);
  other.addBlock([transfer(carol, alice, 1, 0)], 1000);
  other.addBlock([transfer(carol, alice, 1, 1)], 2000);
  const changes = [];
  node.on('mempoolChanged', (c) => changes.push(c));
  node.receiveChain(other.exportBlocks());
  assert.equal(node.ledger.getContract(dep.recipient), null);
  assert.equal(node.mempool.size, 0);
  // At the next height (#3) the unlock height 2 is no longer in the future.
  assert.match(changes[0].dropped[0].reason, /Unlock height 2 must be after this block \(#3\)/);
  assert.equal(node.getBalance(alice.address), 102);
});

// ---------- Gossip over TCP ----------

async function threeNodes(t) {
  const nodes = ['a', 'b', 'c'].map((id) => makeNode(id));
  t.after(() => Promise.all(nodes.map((n) => n.stop())));
  await Promise.all(nodes.map((n) => n.start()));
  const [a, b, c] = nodes;
  for (const [x, y] of [[a, b], [b, c]]) {
    const done = Promise.all([waitFor(x, 'mempoolSynced'), waitFor(y, 'mempoolSynced')]);
    await x.connect(y.port);
    await done;
  }
  return nodes;
}

test('gossip: a deploy reaches all nodes; once mined, every node derives the same contract state', TIMEOUT, async (t) => {
  const [a, b, c] = await threeNodes(t);
  const dep = deploy({ unlockHeight: 3, expiryHeight: 9 });
  const reached = Promise.all([waitFor(b, 'txAccepted'), waitFor(c, 'txAccepted')]);
  a.submitTransaction(dep);
  await reached;
  for (const n of [a, b, c]) assert.ok(n.mempool.has(idOf(dep)));

  const mined = Promise.all([waitFor(a, 'chainUpdated'), waitFor(c, 'chainUpdated')]);
  b.mineFromMempool();
  await mined;
  const states = [a, b, c].map((n) => JSON.stringify(n.ledger.getContracts()));
  assert.equal(new Set(states).size, 1);
  assert.equal(a.ledger.getContract(dep.recipient).status, 'funded');
  for (const n of [a, b, c]) assert.equal(n.mempool.size, 0);
});

test('gossip: a premature claim is rejected where submitted and never relayed', TIMEOUT, async (t) => {
  const [a, b, c] = await threeNodes(t);
  const dep = deploy({ unlockHeight: 5, expiryHeight: 9 });
  const mined = Promise.all([waitFor(b, 'chainUpdated'), waitFor(c, 'chainUpdated')]);
  a.mineBlock([dep]);
  await mined;
  const result = c.submitTransaction(call(bob, dep.recipient, 'claim', 30, 0));
  assert.match(result.reason, /Too early/);
  await Promise.all([a.syncMempool(), b.syncMempool()]); // round trips flush anything in flight
  assert.equal(a.stats.txReceived + b.stats.txReceived, 0);
});

test('a peer sending a malformed contract call is warned and the tx is not stored', TIMEOUT, async (t) => {
  const node = makeNode('n');
  t.after(() => node.stop());
  await node.start();
  const socket = net.createConnection({ port: node.port, host: '127.0.0.1' });
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.setEncoding('utf8');
  let buffer = '';
  const errorReply = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no ERROR reply')), 5000);
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (const line of buffer.split('\n').filter(Boolean)) {
        const message = JSON.parse(line);
        if (message.type === 'ERROR') { clearTimeout(timer); resolve(message); }
      }
    });
  });
  socket.write(`${JSON.stringify({ type: 'HELLO', nodeId: 'mallory', ...node.consensusParams })}\n`);
  const bad = deploy().toJSON();
  bad.contract = { op: 'deploy', template: 'run-my-javascript', params: { code: 'process.exit()' } };
  socket.write(`${JSON.stringify({ type: 'NEW_TX', transaction: bad })}\n`);
  assert.match((await errorReply).message, /Invalid transaction: Unknown contract template/);
  assert.equal(node.mempool.size, 0);
});

test('nodes speak minichain/3 now (contracts changed the rules)', () => {
  assert.equal(makeNode('n').consensusParams.protocol, 'minichain/3');
});
