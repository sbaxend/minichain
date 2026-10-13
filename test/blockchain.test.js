import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Blockchain } from '../src/blockchain.js';

/** A chain with genesis + 3 blocks, using fixed timestamps so tests are repeatable. */
function buildChain() {
  const bc = new Blockchain();
  bc.addBlock([{ from: 'Alice', to: 'Bob', amount: 10 }], 1000);
  bc.addBlock([{ from: 'Bob', to: 'Carol', amount: 5 }], 2000);
  bc.addBlock([{ from: 'Carol', to: 'Dave', amount: 2 }], 3000);
  return bc;
}

// ---------- Genesis ----------

test('genesis block is identical across separate chains', () => {
  assert.equal(new Blockchain().chain[0].hash, new Blockchain().chain[0].hash);
});

test('genesis block has index 0 and an all-zero previousHash', () => {
  const genesis = new Blockchain().chain[0];
  assert.equal(genesis.index, 0);
  assert.equal(genesis.previousHash, '0'.repeat(64));
});

// ---------- Valid chains ----------

test('a new chain with only genesis is valid', () => {
  assert.deepEqual(new Blockchain().validate(), { valid: true });
});

test('a chain built with addBlock is valid', () => {
  assert.deepEqual(buildChain().validate(), { valid: true });
});

test('addBlock links each block to the previous hash', () => {
  const bc = buildChain();
  for (let i = 1; i < bc.chain.length; i++) {
    assert.equal(bc.chain[i].previousHash, bc.chain[i - 1].hash);
    assert.equal(bc.chain[i].index, i);
  }
});

// ---------- Tampered blocks ----------

test('detects modified transaction data', () => {
  const bc = buildChain();
  bc.chain[1].data[0].amount = 1000;
  assert.deepEqual(bc.validate(), {
    valid: false,
    index: 1,
    reason: 'Stored hash does not match block contents',
  });
});

test('detects a modified timestamp', () => {
  const bc = buildChain();
  bc.chain[2].timestamp = 9999;
  assert.equal(bc.validate().index, 2);
});

test('detects a replaced genesis block', () => {
  const bc = buildChain();
  bc.chain[0].data = 'Fake genesis';
  bc.chain[0].hash = bc.chain[0].calculateHash(); // attacker rehashes it
  assert.deepEqual(bc.validate(), { valid: false, index: 0, reason: 'Genesis block is invalid' });
});

// ---------- Broken connections ----------

test('detects a re-mined block whose successor was not updated', () => {
  const bc = buildChain();
  // Attacker edits block 1 AND re-mines it, so block 1 looks fine on its own...
  // (Since Milestone 3, a plain rehash isn't enough — it would fail proof-of-work.)
  bc.chain[1].data[0].amount = 1000;
  bc.chain[1].mine(bc.difficulty);
  assert.ok(bc.chain[1].isValid());
  assert.ok(bc.chain[1].hasValidProof(bc.difficulty));
  // ...but block 2 still points at the OLD hash.
  assert.deepEqual(bc.validate(), {
    valid: false,
    index: 2,
    reason: 'previousHash does not match the previous block',
  });
});

test('detects a removed block', () => {
  const bc = buildChain();
  bc.chain.splice(2, 1); // delete block 2
  assert.equal(bc.validate().valid, false);
});

test('detects swapped blocks', () => {
  const bc = buildChain();
  [bc.chain[1], bc.chain[2]] = [bc.chain[2], bc.chain[1]];
  assert.equal(bc.validate().valid, false);
});

// ---------- Rewriting history (Milestone 2 limitation → closed by proof-of-work) ----------

test('cheaply rehashing every later block (without mining) is now rejected', () => {
  const bc = buildChain();
  bc.chain[1].data[0].amount = 1000;
  for (let i = 1; i < bc.chain.length; i++) {
    bc.chain[i].previousHash = bc.chain[i - 1].hash;
    bc.chain[i].hash = bc.chain[i].calculateHash();
  }
  // In Milestone 2 this passed. Now the rehashed blocks lack proof-of-work.
  assert.equal(bc.isValid(), false);
});

test('LIMITATION: RE-MINING every later block still produces a valid chain', () => {
  const bc = buildChain();
  bc.chain[1].data[0].amount = 1000;
  for (let i = 1; i < bc.chain.length; i++) {
    bc.chain[i].previousHash = bc.chain[i - 1].hash;
    bc.chain[i].mine(bc.difficulty);
  }
  // Proof-of-work makes this rewrite COSTLY, not impossible. On a real network,
  // honest miners keep extending the original chain, so an attacker must out-mine
  // all of them combined to catch up — that's covered with networking later.
  assert.equal(bc.isValid(), true);
});
