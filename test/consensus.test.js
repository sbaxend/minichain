/**
 * Consensus rules, tested WITHOUT networking: chains are handed straight to
 * node.receiveChain(), so these tests are fast and fully deterministic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from '../src/wallet.js';
import { Block } from '../src/block.js';
import { Blockchain } from '../src/blockchain.js';
import { Ledger } from '../src/ledger.js';
import { Node } from '../src/node.js';
import { blockWork, chainWork, chooseChain, describeReorg, transactionId } from '../src/consensus.js';

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

const makeNode = (id, options = {}) => new Node({ id, allocation: ALLOCATION, ...options });

/** A valid ledger with one block per entry in `blocks` (each an array of txs). */
function buildLedger(blocks, { allocation = ALLOCATION, difficulty = 2 } = {}) {
  const ledger = new Ledger(allocation, difficulty);
  blocks.forEach((txs, i) => ledger.addBlock(txs, 1000 + i));
  return ledger;
}

/** Append a block WITHOUT any transaction checks (what an attacker can do). */
function appendUnchecked(ledger, txs) {
  Blockchain.prototype.addBlock.call(ledger, { transactions: txs.map((t) => t.toJSON()) }, 9000);
}

/** Re-link and re-mine blocks from `start` on. */
function remineFrom(ledger, start) {
  for (let i = start; i < ledger.chain.length; i++) {
    ledger.chain[i].previousHash = ledger.chain[i - 1].hash;
    ledger.chain[i].mine(ledger.difficulty);
  }
}

/** Re-link blocks from `start` on so their hashes deliberately FAIL `difficulty`. */
function breakProofFrom(ledger, start, difficulty) {
  for (let i = start; i < ledger.chain.length; i++) {
    const block = ledger.chain[i];
    block.previousHash = ledger.chain[i - 1].hash;
    block.nonce = 0;
    block.hash = block.calculateHash();
    while (block.hasValidProof(difficulty)) {
      block.nonce++;
      block.hash = block.calculateHash();
    }
  }
}

const snapshot = (node) => ({
  ledger: node.ledger,
  tip: node.tipHash,
  height: node.height,
  balances: node.ledger.getBalances(),
});

// ---------- Work & chain choice (pure functions) ----------

test('block work is 16^difficulty; genesis counts as zero', () => {
  assert.equal(blockWork(2), 256n);
  assert.equal(blockWork(3), 4096n);
  assert.equal(chainWork(new Ledger(ALLOCATION, 2)), 0n);
  assert.equal(chainWork(buildLedger([[pay(alice, bob, 1, 0)], [pay(alice, bob, 1, 1)]])), 512n);
});

test('chooseChain: adopt only strictly more work', () => {
  const short = buildLedger([[pay(alice, bob, 1, 0)]]);
  const long = buildLedger([[pay(alice, bob, 1, 0)], [pay(alice, bob, 1, 1)]]);
  const sameLength = buildLedger([[pay(bob, alice, 1, 0)]]);
  assert.equal(chooseChain(short, long).adopt, true);
  assert.equal(chooseChain(long, short).adopt, false);
  assert.match(chooseChain(short, sameLength).reason, /Equal work.*first/);
  assert.equal(chooseChain(short, sameLength).adopt, false);
  assert.equal(chooseChain(short, short).reason, 'Already in sync');
});

test('describeReorg finds the fork point and orphaned transactions', () => {
  const shared = pay(alice, bob, 5, 0);
  const onlyOld = pay(charlie, alice, 20, 0);
  const oldLedger = buildLedger([[shared], [onlyOld]]);
  const newLedger = buildLedger([[shared], [pay(bob, alice, 1, 0)], [pay(bob, alice, 1, 1)]]);
  const reorg = describeReorg(oldLedger, newLedger);
  assert.equal(reorg.forkHeight, 1);
  assert.deepEqual(reorg.removedBlocks, [oldLedger.chain[2].hash]);
  assert.equal(reorg.addedBlocks.length, 2);
  assert.deepEqual(reorg.orphanedTransactions.map(transactionId), [transactionId(onlyOld.toJSON())]);
});

test('a transaction in both branches is not reported as orphaned', () => {
  const tx = pay(alice, bob, 5, 0);
  const oldLedger = buildLedger([[tx]]);
  const newLedger = new Ledger(ALLOCATION, 2);
  newLedger.addBlock([pay(bob, charlie, 1, 0)], 5000);
  newLedger.addBlock([tx], 6000); // same tx, different block
  assert.deepEqual(describeReorg(oldLedger, newLedger).orphanedTransactions, []);
});

// ---------- Block serialization ----------

test('Block toJSON → fromJSON round-trips and shares no objects', () => {
  const ledger = buildLedger([[pay(alice, bob, 1, 0)]]);
  const original = ledger.chain[1];
  const json = original.toJSON();
  const copy = Block.fromJSON(json);
  assert.deepEqual(copy.toJSON(), json);
  assert.ok(copy.isValid());
  json.data.transactions[0].amount = 999; // mutate the plain data...
  assert.equal(copy.data.transactions[0].amount, 1); // ...the copy is unaffected
  assert.equal(original.data.transactions[0].amount, 1);
});

test('Block.fromJSON rejects malformed blocks', () => {
  const good = buildLedger([[pay(alice, bob, 1, 0)]]).chain[1].toJSON();
  const bad = [
    null, [], 'block',
    { ...good, extra: 1 },
    (({ nonce, ...rest }) => rest)(good),
    { ...good, index: -1 },
    { ...good, nonce: 1.5 },
    { ...good, timestamp: '1000' },
    { ...good, hash: 'abc' },
    { ...good, previousHash: 'Z'.repeat(64) },
  ];
  for (const json of bad) assert.throws(() => Block.fromJSON(json), TypeError);
});

test('Ledger.fromBlocks builds a fresh, fully validated ledger', () => {
  const source = buildLedger([[pay(alice, bob, 1, 0)]]);
  const copy = Ledger.fromBlocks(ALLOCATION, 2, source.exportBlocks());
  assert.notEqual(copy, source);
  assert.notEqual(copy.chain[1], source.chain[1]);
  assert.equal(copy.getLatestBlock().hash, source.getLatestBlock().hash);
  assert.throws(() => Ledger.fromBlocks(ALLOCATION, 2, []), /non-empty/);
  assert.throws(() => Ledger.fromBlocks(ALLOCATION, 2, 'chain'), /non-empty/);
});

// ---------- Independent node state ----------

test('nodes never share ledgers or block objects', () => {
  const a = makeNode('a');
  const b = makeNode('b');
  assert.notEqual(a.ledger, b.ledger);
  a.mineBlock([pay(alice, bob, 10, 0)], 1000);
  assert.equal(b.height, 0); // mining on A didn't touch B

  b.receiveChain(a.ledger.exportBlocks());
  assert.equal(b.tipHash, a.tipHash);
  assert.notEqual(b.ledger.chain[1], a.ledger.chain[1]);

  a.ledger.chain[1].data.transactions[0].amount = 999; // corrupt A's copy
  assert.equal(b.ledger.isValid(), true); // B is unaffected
  assert.equal(b.getBalance(bob.address), 110);
});

// ---------- Adopting / rejecting valid chains ----------

test('a valid chain with more work is adopted and balances are recalculated', () => {
  const node = makeNode('n');
  const result = node.receiveChain(buildLedger([[pay(alice, bob, 30, 0)], [pay(bob, charlie, 50, 0)]]).exportBlocks());
  assert.equal(result.adopted, true);
  assert.equal(node.height, 2);
  assert.deepEqual(
    [alice, bob, charlie].map((w) => node.getBalance(w.address)),
    [70, 80, 150]
  );
});

test('a valid chain with LESS work is rejected', () => {
  const node = makeNode('n');
  node.mineBlock([pay(alice, bob, 1, 0)], 1000);
  node.mineBlock([pay(alice, bob, 1, 1)], 2000);
  const before = snapshot(node);
  const result = node.receiveChain(buildLedger([[pay(charlie, bob, 50, 0)]]).exportBlocks());
  assert.equal(result.adopted, false);
  assert.equal(result.invalid, false);
  assert.match(result.reason, /Less work/);
  assert.deepEqual(snapshot(node), before);
});

test('equal work: the node keeps the chain it saw first (deterministic tie rule)', () => {
  const node = makeNode('n');
  node.mineBlock([pay(alice, bob, 1, 0)], 1000);
  const before = snapshot(node);
  const rival = buildLedger([[pay(charlie, bob, 1, 0)]]);
  const result = node.receiveChain(rival.exportBlocks());
  assert.equal(result.adopted, false);
  assert.match(result.reason, /Equal work/);
  assert.deepEqual(snapshot(node), before);
  // The tie breaks as soon as one side mines another block.
  rival.addBlock([pay(charlie, bob, 1, 1)], 2000);
  assert.equal(node.receiveChain(rival.exportBlocks()).adopted, true);
});

test('receiving our own chain again changes nothing', () => {
  const node = makeNode('n');
  node.mineBlock([pay(alice, bob, 1, 0)], 1000);
  assert.equal(node.receiveChain(node.ledger.exportBlocks()).reason, 'Already in sync');
});

// ---------- Rejecting invalid chains (all LONGER than ours, so only validity stops them) ----------

function assertRejectedUnchanged(node, blocks, pattern) {
  const before = snapshot(node);
  const rejected = [];
  node.once('chainRejected', (e) => rejected.push(e));
  const result = node.receiveChain(blocks, 'attacker');
  assert.equal(result.adopted, false);
  assert.equal(result.invalid, true);
  assert.match(result.reason, pattern);
  assert.equal(rejected.length, 1);
  assert.deepEqual(snapshot(node), before);
}

test('different genesis allocation is rejected', () => {
  const other = buildLedger(
    [[pay(alice, bob, 1, 0)], [pay(alice, bob, 1, 1)]],
    { allocation: [{ address: alice.address, amount: 1_000_000 }] }
  );
  assertRejectedUnchanged(makeNode('n'), other.exportBlocks(), /block 0: Genesis block is invalid/);
});

test('chain whose blocks miss OUR difficulty is rejected', () => {
  const node = makeNode('n', { difficulty: 3 });
  const weak = buildLedger([[pay(alice, bob, 1, 0)], [pay(alice, bob, 1, 1)]], { difficulty: 1 });
  breakProofFrom(weak, 1, 3); // guarantee: no block accidentally meets difficulty 3
  assertRejectedUnchanged(node, weak.exportBlocks(), /block 1: Hash does not meet difficulty 3/);
});

test('work is measured with OUR difficulty, not the sender\'s', () => {
  const node = makeNode('n', { difficulty: 1 });
  const harder = buildLedger([[pay(alice, bob, 1, 0)]], { difficulty: 3 });
  const result = node.receiveChain(harder.exportBlocks());
  assert.equal(result.adopted, true); // valid under our rules...
  assert.equal(chainWork(node.ledger), 16n); // ...but credited at OUR difficulty (16^1)
});

test('invalid signature is rejected', () => {
  const evil = buildLedger([[pay(alice, bob, 1, 0)], [pay(alice, bob, 1, 1)], [pay(alice, bob, 1, 2)]]);
  evil.chain[1].data.transactions[0].amount = 90; // tamper...
  remineFrom(evil, 1); // ...and redo the proof-of-work
  assertRejectedUnchanged(makeNode('n'), evil.exportBlocks(), /block 1: Transaction 0: Invalid signature/);
});

test('insufficient funds is rejected', () => {
  const evil = buildLedger([[pay(alice, bob, 1, 0)]]);
  appendUnchecked(evil, [pay(alice, charlie, 500, 1)]); // properly signed, unaffordable
  assertRejectedUnchanged(makeNode('n'), evil.exportBlocks(), /block 2: .*Insufficient funds/);
});

test('double-spend inside one block is rejected', () => {
  const evil = new Ledger(ALLOCATION, 2);
  appendUnchecked(evil, [pay(alice, bob, 80, 0), pay(alice, charlie, 80, 1)]);
  appendUnchecked(evil, [pay(bob, charlie, 1, 0)]);
  assertRejectedUnchanged(makeNode('n'), evil.exportBlocks(), /block 1: Transaction 1: Insufficient funds/);
});

test('skipped transaction nonce is rejected', () => {
  const evil = buildLedger([[pay(alice, bob, 1, 0)]]);
  appendUnchecked(evil, [pay(alice, bob, 1, 5)]);
  assertRejectedUnchanged(makeNode('n'), evil.exportBlocks(), /Nonce 5 skips ahead/);
});

test('replayed transaction (reused nonce) is rejected', () => {
  const tx = pay(alice, bob, 1, 0);
  const evil = buildLedger([[tx]]);
  appendUnchecked(evil, [tx]);
  assertRejectedUnchanged(makeNode('n'), evil.exportBlocks(), /Nonce 0 already used/);
});

test('missing proof-of-work is rejected', () => {
  const evil = buildLedger([[pay(alice, bob, 1, 0)], [pay(alice, bob, 1, 1)]]);
  breakProofFrom(evil, 1, 2);
  assertRejectedUnchanged(makeNode('n'), evil.exportBlocks(), /block 1: Hash does not meet difficulty 2/);
});

test('malformed chain data is rejected without throwing', () => {
  const node = makeNode('n');
  const good = buildLedger([[pay(alice, bob, 1, 0)]]).exportBlocks();
  for (const blocks of [null, 'chain', [], [null], [{}], [good[0], { ...good[1], extra: true }]]) {
    assertRejectedUnchanged(node, blocks, /./);
  }
});

// ---------- Atomic replacement ----------

test('a longer chain that is valid until its LAST block is rejected atomically', () => {
  const node = makeNode('n');
  node.mineBlock([pay(charlie, alice, 7, 0)], 1000);
  const before = snapshot(node);

  const evil = buildLedger([[pay(alice, bob, 1, 0)], [pay(alice, bob, 1, 1)], [pay(alice, bob, 1, 2)]]);
  appendUnchecked(evil, [pay(bob, charlie, 10_000, 0)]); // only the last block is bad
  assertRejectedUnchanged(node, evil.exportBlocks(), /block 4/);
  assert.equal(node.ledger, before.ledger); // literally the same object
  assert.equal(node.getBalance(charlie.address), 93);
});

// ---------- Reorganizations ----------

test('reorg: balances and nonces are recalculated from the adopted chain', () => {
  const node = makeNode('n');
  node.mineBlock([pay(charlie, alice, 20, 0)], 1000); // node's own branch
  assert.equal(node.getBalance(charlie.address), 80);
  assert.equal(node.ledger.getNextNonce(charlie.address), 1);

  const reorgs = [];
  node.on('reorg', (r) => reorgs.push(r));
  const winner = buildLedger([[pay(alice, bob, 10, 0)], [pay(bob, alice, 5, 0)]]);
  const result = node.receiveChain(winner.exportBlocks());

  assert.equal(result.adopted, true);
  assert.equal(reorgs.length, 1);
  assert.deepEqual(
    [alice, bob, charlie].map((w) => node.getBalance(w.address)),
    [95, 105, 100] // Charlie's 20 is no longer confirmed
  );
  assert.equal(node.ledger.getNextNonce(charlie.address), 0);
});

test('reorg: transactions from the abandoned branch are reported as orphaned', () => {
  const node = makeNode('n');
  const orphan = pay(charlie, alice, 20, 0);
  node.mineBlock([orphan], 1000);
  const result = node.receiveChain(buildLedger([[pay(alice, bob, 10, 0)], [pay(bob, alice, 5, 0)]]).exportBlocks());

  assert.equal(result.reorg.forkHeight, 0);
  assert.equal(result.reorg.removedBlocks.length, 1);
  assert.equal(result.reorg.addedBlocks.length, 2);
  assert.deepEqual(result.reorg.orphanedTransactions, [orphan.toJSON()]);
  assert.ok(!node.ledger.chain.some((b) => b.data.transactions?.some((t) => t.signature === orphan.signature)));
});

test('an orphaned transaction can be resubmitted if it is still valid', () => {
  const node = makeNode('n');
  const orphan = pay(charlie, alice, 20, 0);
  node.mineBlock([orphan], 1000);
  const { reorg } = node.receiveChain(buildLedger([[pay(alice, bob, 10, 0)], [pay(bob, alice, 5, 0)]]).exportBlocks());
  node.mineBlock(reorg.orphanedTransactions, 3000);
  assert.equal(node.getBalance(charlie.address), 80);
});

test('an orphaned transaction that conflicts with the new chain cannot be resubmitted', () => {
  const node = makeNode('n');
  const orphan = pay(charlie, alice, 20, 0);
  node.mineBlock([orphan], 1000);
  // The winning branch already contains a DIFFERENT Charlie tx with nonce 0.
  const { reorg } = node.receiveChain(buildLedger([[pay(charlie, bob, 90, 0)], [pay(bob, alice, 5, 0)]]).exportBlocks());
  assert.throws(() => node.mineBlock(reorg.orphanedTransactions), /Nonce 0 already used/);
});
