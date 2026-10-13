import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Block } from '../src/block.js';
import { Blockchain, DEFAULT_DIFFICULTY } from '../src/blockchain.js';

const PREV = '0'.repeat(64);
const txs = [{ from: 'Alice', to: 'Bob', amount: 10 }];

/**
 * Bump the nonce until the hash does NOT meet the difficulty.
 * Gives us a block with a correct (self-consistent) hash but no valid proof-of-work.
 */
function breakProof(block, difficulty) {
  do {
    block.nonce++;
    block.hash = block.calculateHash();
  } while (block.hasValidProof(difficulty));
}

function buildChain(difficulty = DEFAULT_DIFFICULTY) {
  const bc = new Blockchain(difficulty);
  bc.addBlock(txs, 1000);
  bc.addBlock([{ from: 'Bob', to: 'Carol', amount: 5 }], 2000);
  bc.addBlock([{ from: 'Carol', to: 'Dave', amount: 2 }], 3000);
  return bc;
}

// ---------- Nonce ----------

test('a new block starts with nonce 0', () => {
  assert.equal(new Block(1, 1000, txs, PREV).nonce, 0);
});

test('the nonce is part of the hash', () => {
  const block = new Block(1, 1000, txs, PREV);
  const before = block.hash;
  block.nonce = 1;
  assert.notEqual(block.calculateHash(), before);
  assert.equal(block.isValid(), false); // stored hash is now stale
});

// ---------- mine() ----------

for (const difficulty of [1, 2, 3]) {
  test(`mine(${difficulty}) produces a hash starting with ${difficulty} zero(s)`, () => {
    const block = new Block(1, 1000, txs, PREV);
    block.mine(difficulty);
    assert.ok(block.hash.startsWith('0'.repeat(difficulty)), block.hash);
    assert.ok(block.hasValidProof(difficulty));
    assert.ok(block.isValid());
  });
}

test('mine() returns the number of attempts (nonce + 1)', () => {
  const block = new Block(1, 1000, txs, PREV);
  const attempts = block.mine(2);
  assert.equal(attempts, block.nonce + 1);
});

test('mining is deterministic: same block contents → same nonce', () => {
  const a = new Block(1, 1000, txs, PREV);
  const b = new Block(1, 1000, txs, PREV);
  a.mine(2);
  b.mine(2);
  assert.equal(a.nonce, b.nonce);
  assert.equal(a.hash, b.hash);
});

test('difficulty 0 needs no work: first attempt succeeds', () => {
  const block = new Block(1, 1000, txs, PREV);
  assert.equal(block.mine(0), 1);
  assert.equal(block.nonce, 0);
});

test('invalid difficulty values are rejected', () => {
  const block = new Block(1, 1000, txs, PREV);
  for (const bad of [-1, 65, 1.5, '2', NaN]) {
    assert.throws(() => block.mine(bad), RangeError);
    assert.throws(() => new Blockchain(bad), RangeError);
  }
});

// ---------- Blockchain + proof-of-work ----------

test('addBlock mines every new block at the chain difficulty', () => {
  const bc = buildChain(3);
  for (const block of bc.chain.slice(1)) {
    assert.ok(block.hash.startsWith('000'), block.hash);
  }
  assert.deepEqual(bc.validate(), { valid: true });
});

test('genesis is exempt: never mined, nonce 0, chain still valid', () => {
  const bc = buildChain(3);
  const genesis = bc.chain[0];
  assert.equal(genesis.nonce, 0);
  assert.equal(genesis.hash, Blockchain.createGenesisBlock().hash);
  // Genesis does not meet difficulty 3, yet validation passes — that's the exemption.
  assert.equal(genesis.hasValidProof(3), false);
  assert.equal(bc.isValid(), true);
});

test('genesis is the same regardless of chain difficulty', () => {
  assert.equal(new Blockchain(1).chain[0].hash, new Blockchain(4).chain[0].hash);
});

// ---------- Invalid proof-of-work ----------

test('rejects a block whose hash is correct but lacks proof-of-work', () => {
  const bc = buildChain();
  breakProof(bc.chain[2], bc.difficulty);
  assert.ok(bc.chain[2].isValid()); // hash matches contents...
  assert.deepEqual(bc.validate(), {  // ...but no proof-of-work
    valid: false,
    index: 2,
    reason: `Hash does not meet difficulty ${bc.difficulty} (proof-of-work missing)`,
  });
});

test('rejects a forged hash that just starts with zeros', () => {
  const bc = buildChain();
  // Attacker writes a fake "00..." hash instead of mining for one.
  bc.chain[1].hash = '00ff' + 'a'.repeat(60);
  assert.equal(bc.validate().reason, 'Stored hash does not match block contents');
});

// ---------- Tampering ----------

test('tampering with mined data invalidates the block', () => {
  const bc = buildChain();
  bc.chain[1].data[0].amount = 1000;
  assert.deepEqual(bc.validate(), {
    valid: false,
    index: 1,
    reason: 'Stored hash does not match block contents',
  });
});

test('tampering with the nonce invalidates the block', () => {
  const bc = buildChain();
  bc.chain[1].nonce += 1;
  assert.equal(bc.validate().index, 1);
});

test('tampering then rehashing (without mining) fails proof-of-work', () => {
  const bc = buildChain();
  bc.chain[1].data[0].amount = 1000;
  bc.chain[1].hash = bc.chain[1].calculateHash();
  // Small chance a plain rehash happens to start with "00"; this block's doesn't.
  assert.equal(bc.chain[1].hasValidProof(bc.difficulty), false);
  assert.equal(bc.validate().index, 1);
  assert.match(bc.validate().reason, /proof-of-work/);
});
