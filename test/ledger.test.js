import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from '../src/wallet.js';
import { Transaction } from '../src/transaction.js';
import { Block } from '../src/block.js';
import { Blockchain } from '../src/blockchain.js';
import { Ledger, MAX_TOTAL_ALLOCATION } from '../src/ledger.js';

const alice = new Wallet();
const bob = new Wallet();
const charlie = new Wallet();

/** Fresh ledger: Alice 100, Bob 0, Charlie 0. */
function newLedger() {
  return new Ledger([{ address: alice.address, amount: 100 }]);
}

/** A signed transfer with a fixed timestamp. */
function pay(from, to, amount, nonce) {
  return from.signTransaction(from.createTransaction(to.address, amount, { nonce, timestamp: 1000 }));
}

/** The demo scenario: ends with Alice 5, Bob 50, Charlie 45. */
function scenarioLedger() {
  const ledger = newLedger();
  ledger.addBlock([pay(alice, bob, 80, 0)], 1000);
  ledger.addBlock([pay(alice, charlie, 15, 1)], 2000);
  ledger.addBlock([pay(bob, charlie, 30, 0)], 3000);
  return ledger;
}

function balances(ledger) {
  return [alice, bob, charlie].map((w) => ledger.getBalance(w.address));
}

/** Re-link and re-mine every block from `start` onward (what an attacker would do). */
function remineFrom(ledger, start) {
  for (let i = start; i < ledger.chain.length; i++) {
    ledger.chain[i].index = i;
    ledger.chain[i].previousHash = ledger.chain[i - 1].hash;
    ledger.chain[i].mine(ledger.difficulty);
  }
}

// ---------- Initial balances & allocation ----------

test('initial balances come from the allocation', () => {
  const ledger = newLedger();
  assert.deepEqual(balances(ledger), [100, 0, 0]);
  assert.equal(ledger.totalSupply, 100);
  assert.deepEqual(ledger.validate(), { valid: true });
});

test('the allocation is stored in genesis and is deterministic', () => {
  const allocation = [
    { address: alice.address, amount: 100 },
    { address: bob.address, amount: 50 },
  ];
  const a = new Ledger(allocation);
  const b = new Ledger([...allocation].reverse()); // same allocation, different order
  assert.equal(a.chain[0].hash, b.chain[0].hash);
  assert.equal(a.chain[0].hash, Ledger.createGenesisBlock(allocation).hash);
  assert.deepEqual(a.chain[0].data.allocation.length, 2);
});

test('a different allocation gives a different genesis', () => {
  const a = new Ledger([{ address: alice.address, amount: 100 }]);
  const b = new Ledger([{ address: alice.address, amount: 101 }]);
  assert.notEqual(a.chain[0].hash, b.chain[0].hash);
});

test('ledger genesis differs from the legacy genesis', () => {
  assert.notEqual(newLedger().chain[0].hash, Blockchain.createGenesisBlock().hash);
});

test('an empty allocation is allowed (no coins exist)', () => {
  const ledger = new Ledger([]);
  assert.equal(ledger.totalSupply, 0);
  assert.throws(() => ledger.addBlock([pay(alice, bob, 1, 0)]), /Insufficient funds/);
});

// ---------- Invalid initial allocations ----------

const invalidAllocations = [
  ['not an array', { address: 'x', amount: 1 }, TypeError],
  ['invalid address', [{ address: 'Alice', amount: 10 }], TypeError],
  ['zero amount', [{ address: alice.address, amount: 0 }], RangeError],
  ['negative amount', [{ address: alice.address, amount: -5 }], RangeError],
  ['fractional amount', [{ address: alice.address, amount: 1.5 }], RangeError],
  ['string amount', [{ address: alice.address, amount: '100' }], RangeError],
  ['extra field', [{ address: alice.address, amount: 10, note: 'hi' }], TypeError],
  ['duplicate address', [
    { address: alice.address, amount: 10 },
    { address: alice.address, amount: 10 },
  ], RangeError],
  ['total over the limit', [
    { address: alice.address, amount: MAX_TOTAL_ALLOCATION },
    { address: bob.address, amount: 1 },
  ], RangeError],
];
for (const [label, allocation, ErrorType] of invalidAllocations) {
  test(`invalid allocation rejected: ${label}`, () => {
    assert.throws(() => new Ledger(allocation), ErrorType);
  });
}

test('editing the genesis allocation is rejected, even if genesis is rehashed', () => {
  const ledger = newLedger();
  // structuredClone because the agreed allocation is frozen; the attacker swaps in a copy.
  const forged = structuredClone(ledger.chain[0].data);
  forged.allocation[0].amount = 1_000_000;
  ledger.chain[0].data = forged;
  ledger.chain[0].hash = ledger.chain[0].calculateHash();
  assert.deepEqual(ledger.validate(), { valid: false, index: 0, reason: 'Genesis block is invalid' });
});

// ---------- Valid transfers ----------

test('a valid transfer moves coins and advances the sender nonce', () => {
  const ledger = newLedger();
  ledger.addBlock([pay(alice, bob, 80, 0)], 1000);
  assert.deepEqual(balances(ledger), [20, 80, 0]);
  assert.equal(ledger.getNextNonce(alice.address), 1);
  assert.equal(ledger.getNextNonce(bob.address), 0);
  assert.deepEqual(ledger.validate(), { valid: true });
});

test('the full demo scenario ends at Alice 5, Bob 50, Charlie 45', () => {
  const ledger = scenarioLedger();
  assert.deepEqual(balances(ledger), [5, 50, 45]);
  assert.deepEqual(ledger.validate(), { valid: true });
});

test('blocks in a ledger are still mined and linked', () => {
  const ledger = scenarioLedger();
  for (const block of ledger.chain.slice(1)) {
    assert.ok(block.hasValidProof(ledger.difficulty));
  }
});

test('a recipient can spend coins once they have them', () => {
  const ledger = newLedger();
  ledger.addBlock([pay(alice, bob, 80, 0)]);
  ledger.addBlock([pay(bob, charlie, 80, 0)]);
  assert.deepEqual(balances(ledger), [20, 0, 80]);
});

test('sending the exact full balance is allowed', () => {
  const ledger = newLedger();
  ledger.addBlock([pay(alice, bob, 100, 0)]);
  assert.deepEqual(balances(ledger), [0, 100, 0]);
});

// ---------- Insufficient funds ----------

test('spending more than the balance is rejected and nothing is added', () => {
  const ledger = newLedger();
  ledger.addBlock([pay(alice, bob, 80, 0)]);
  assert.throws(
    () => ledger.addBlock([pay(alice, charlie, 80, 1)]),
    /Transaction 0: Insufficient funds: balance 20, tried to send 80/
  );
  assert.equal(ledger.chain.length, 2);
  assert.deepEqual(balances(ledger), [20, 80, 0]);
});

test('a wallet with no coins cannot send any', () => {
  assert.throws(() => newLedger().addBlock([pay(charlie, bob, 1, 0)]), /Insufficient funds: balance 0/);
});

test('a valid signature is not enough: insufficient funds still rejected', () => {
  const tx = pay(alice, bob, 1_000, 0);
  assert.ok(tx.isValid()); // perfectly signed...
  assert.throws(() => newLedger().addBlock([tx]), /Insufficient funds/); // ...but unaffordable
});

// ---------- Invalid signatures ----------

test('a transaction altered after signing is rejected', () => {
  const tx = pay(alice, bob, 10, 0);
  tx.amount = 90;
  assert.throws(() => newLedger().addBlock([tx]), /Invalid signature/);
});

test('an unsigned transaction is rejected', () => {
  const tx = alice.createTransaction(bob.address, 10);
  assert.throws(() => newLedger().addBlock([tx]), /not signed/);
});

test('Bob cannot spend Alice\'s coins with a forged signature', () => {
  const forged = new Transaction({
    sender: alice.address,
    recipient: bob.address,
    amount: 50,
    senderPublicKey: alice.publicKey,
    timestamp: 1000,
    nonce: 0,
  });
  forged.signature = bob.sign(forged.signingPayload());
  assert.throws(() => newLedger().addBlock([forged]), /Invalid signature/);
});

test('sending to yourself is rejected', () => {
  const tx = pay(alice, alice, 10, 0);
  assert.throws(() => newLedger().addBlock([tx]), /must be different/);
});

// ---------- Double-spending ----------

test('double-spend across blocks is rejected', () => {
  const ledger = newLedger();
  ledger.addBlock([pay(alice, bob, 60, 0)]);
  assert.throws(() => ledger.addBlock([pay(alice, charlie, 60, 1)]), /Insufficient funds/);
});

test('double-spend inside ONE block is rejected (each tx affordable alone)', () => {
  const ledger = newLedger();
  const toBob = pay(alice, bob, 60, 0);
  const toCharlie = pay(alice, charlie, 60, 1);
  assert.throws(
    () => ledger.addBlock([toBob, toCharlie]),
    /Transaction 1: Insufficient funds: balance 40, tried to send 60/
  );
  assert.equal(ledger.chain.length, 1);
  assert.deepEqual(balances(ledger), [100, 0, 0]);
});

test('the same transaction twice in one block is rejected', () => {
  const tx = pay(alice, bob, 10, 0);
  assert.throws(() => newLedger().addBlock([tx, tx]), /Transaction 1: Nonce 0 already used/);
});

test('a hand-built overspending block that bypasses addBlock fails validation', () => {
  const ledger = newLedger();
  const data = { transactions: [pay(alice, bob, 60, 0).toJSON(), pay(alice, charlie, 60, 1).toJSON()] };
  const block = new Block(1, 1000, data, ledger.getLatestBlock().hash);
  block.mine(ledger.difficulty);
  ledger.chain.push(block);
  assert.deepEqual(ledger.validate(), {
    valid: false,
    index: 1,
    reason: 'Transaction 1: Insufficient funds: balance 40, tried to send 60',
  });
  assert.throws(() => ledger.getBalance(alice.address), /Chain is invalid at block 1/);
});

// ---------- Replay attacks ----------

test('replaying an accepted transaction in a later block is rejected', () => {
  const ledger = newLedger();
  const tx = pay(alice, bob, 10, 0);
  ledger.addBlock([tx]);
  assert.ok(tx.isValid()); // the signature is still perfectly valid...
  assert.throws(() => ledger.addBlock([tx]), /Nonce 0 already used \(replay\?\); expected 1/);
  assert.deepEqual(balances(ledger), [90, 10, 0]);
});

test('a replay hidden in a hand-built block fails validation', () => {
  const ledger = newLedger();
  const tx = pay(alice, bob, 10, 0);
  ledger.addBlock([tx]);
  const block = new Block(2, 2000, { transactions: [tx.toJSON()] }, ledger.getLatestBlock().hash);
  block.mine(ledger.difficulty);
  ledger.chain.push(block);
  assert.match(ledger.validate().reason, /already used/);
});

test('LIMITATION: the same transaction is valid on a different ledger with the same allocation', () => {
  // No chain ID is signed, so a transaction can be replayed across separate
  // MiniChain ledgers. Real chains sign a chain ID to prevent this.
  const tx = pay(alice, bob, 10, 0);
  newLedger().addBlock([tx]);
  assert.doesNotThrow(() => newLedger().addBlock([tx]));
});

// ---------- Incorrect transaction nonces ----------

test('a first transaction must use nonce 0 (skipping is rejected)', () => {
  assert.throws(() => newLedger().addBlock([pay(alice, bob, 10, 1)]), /Nonce 1 skips ahead; expected 0/);
});

test('reusing a nonce with different content is rejected', () => {
  const ledger = newLedger();
  ledger.addBlock([pay(alice, bob, 10, 0)]);
  assert.throws(() => ledger.addBlock([pay(alice, charlie, 5, 0)]), /Nonce 0 already used/);
});

test('jumping ahead later is rejected too', () => {
  const ledger = newLedger();
  ledger.addBlock([pay(alice, bob, 10, 0)]);
  assert.throws(() => ledger.addBlock([pay(alice, bob, 10, 5)]), /Nonce 5 skips ahead; expected 1/);
});

test('a rejected transaction does not use up its nonce', () => {
  const ledger = newLedger();
  assert.throws(() => ledger.addBlock([pay(alice, bob, 500, 0)]));
  assert.equal(ledger.getNextNonce(alice.address), 0);
  ledger.addBlock([pay(alice, bob, 50, 0)]);
  assert.equal(ledger.getNextNonce(alice.address), 1);
});

test('nonces are tracked per sender', () => {
  const ledger = newLedger();
  ledger.addBlock([pay(alice, bob, 50, 0)]);
  ledger.addBlock([pay(bob, charlie, 10, 0)]); // Bob's first tx is nonce 0
  assert.equal(ledger.getNextNonce(alice.address), 1);
  assert.equal(ledger.getNextNonce(bob.address), 1);
});

// ---------- Sequential processing ----------

test('within a block, a tx can spend coins received earlier in the same block', () => {
  const ledger = newLedger();
  ledger.addBlock([pay(alice, bob, 80, 0), pay(bob, charlie, 50, 0)]);
  assert.deepEqual(balances(ledger), [20, 30, 50]);
});

test('order matters: spending before receiving in the same block is rejected', () => {
  assert.throws(
    () => newLedger().addBlock([pay(bob, charlie, 50, 0), pay(alice, bob, 80, 0)]),
    /Transaction 0: Insufficient funds: balance 0/
  );
});

test('nonces out of order within a block are rejected', () => {
  assert.throws(
    () => newLedger().addBlock([pay(alice, bob, 10, 1), pay(alice, bob, 10, 0)]),
    /Transaction 0: Nonce 1 skips ahead/
  );
});

test('consecutive nonces in one block are accepted', () => {
  const ledger = newLedger();
  ledger.addBlock([pay(alice, bob, 10, 0), pay(alice, charlie, 20, 1), pay(alice, bob, 5, 2)]);
  assert.deepEqual(balances(ledger), [65, 15, 20]);
  assert.equal(ledger.getNextNonce(alice.address), 3);
});

// ---------- Balance conservation ----------

test('total coins never change: sum of balances always equals total supply', () => {
  const ledger = new Ledger([
    { address: alice.address, amount: 100 },
    { address: bob.address, amount: 40 },
  ]);
  const sum = () => Object.values(ledger.getBalances()).reduce((a, b) => a + b, 0);
  assert.equal(sum(), 140);
  ledger.addBlock([pay(alice, bob, 30, 0), pay(bob, charlie, 70, 0)]);
  assert.equal(sum(), 140);
  ledger.addBlock([pay(charlie, alice, 70, 0)]);
  assert.equal(sum(), 140);
  assert.equal(ledger.totalSupply, 140);
});

test('ordinary transactions cannot create coins (no unsigned/minting data accepted)', () => {
  const ledger = newLedger();
  // Try sneaking a "mint" entry in as a transaction, and an extra key on the block data.
  assert.throws(() => ledger.addBlock([{ recipient: charlie.address, amount: 1000 }]), /exactly these fields/);
  const withExtra = { ...pay(alice, bob, 10, 0).toJSON(), mint: true };
  assert.throws(() => ledger.addBlock([withExtra]), /exactly these fields/);
});

test('an empty block is rejected', () => {
  assert.throws(() => newLedger().addBlock([]), /at least one transaction/);
});

test('legacy (non-transaction) data cannot be slipped into a ledger', () => {
  const ledger = newLedger();
  // Bypass Ledger.addBlock by calling the legacy method directly.
  Blockchain.prototype.addBlock.call(ledger, 'Alice gets 1,000,000 coins');
  assert.match(ledger.validate().reason, /Block data must be exactly \{ transactions/);
});

test('extra keys on block data are rejected', () => {
  const ledger = newLedger();
  Blockchain.prototype.addBlock.call(ledger, {
    transactions: [pay(alice, bob, 10, 0).toJSON()],
    bonus: { address: charlie.address, amount: 500 },
  });
  assert.equal(ledger.isValid(), false);
});

// ---------- Tampering and re-mining ----------

test('tampering with a confirmed amount + re-mining is rejected (bad signature)', () => {
  const ledger = scenarioLedger();
  ledger.chain[1].data.transactions[0].amount = 8; // Alice "only sent 8"
  remineFrom(ledger, 1);
  assert.equal(ledger.chain.slice(1).every((b) => b.hasValidProof(ledger.difficulty)), true);
  assert.deepEqual(ledger.validate(), { valid: false, index: 1, reason: 'Transaction 0: Invalid signature' });
});

test('tampering with a confirmed recipient + re-mining is rejected', () => {
  const ledger = scenarioLedger();
  ledger.chain[1].data.transactions[0].recipient = charlie.address;
  remineFrom(ledger, 1);
  assert.equal(ledger.validate().reason, 'Transaction 0: Invalid signature');
});

test('even the real owner re-signing history + re-mining fails if balances break', () => {
  const ledger = scenarioLedger();
  // Alice re-signs her first payment as 95 instead of 80. Signature is valid!
  ledger.chain[1].data.transactions[0] = pay(alice, bob, 95, 0).toJSON();
  remineFrom(ledger, 1);
  // ...but now her later 15-coin payment overspends (she'd only have 5).
  assert.deepEqual(ledger.validate(), {
    valid: false,
    index: 2,
    reason: 'Transaction 0: Insufficient funds: balance 5, tried to send 15',
  });
});

test('deleting a confirmed block + re-mining breaks the nonce sequence', () => {
  const ledger = scenarioLedger();
  ledger.chain.splice(1, 1); // remove Alice's nonce-0 payment
  remineFrom(ledger, 1);
  assert.match(ledger.validate().reason, /Nonce 1 skips ahead; expected 0/);
});

test('cached-looking values are not trusted: balances come from replay', () => {
  const ledger = scenarioLedger();
  ledger.chain[3].data.transactions[0].amount = 1; // tamper without re-mining
  assert.throws(() => ledger.getBalance(charlie.address), /Chain is invalid/);
});

test('LIMITATION: a rewrite that obeys every rule, re-mined, is accepted', () => {
  const ledger = scenarioLedger();
  // Alice re-signs her first payment as 70 instead of 80: all later txs still affordable.
  ledger.chain[1].data.transactions[0] = pay(alice, bob, 70, 0).toJSON();
  remineFrom(ledger, 1);
  assert.equal(ledger.isValid(), true);
  assert.deepEqual(balances(ledger), [15, 40, 45]);
  // Rules can't tell WHICH valid history is "real" — that's what network
  // consensus (longest/most-work chain) decides, in a later milestone.
});
