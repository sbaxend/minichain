/**
 * Mempool admission rules, tested directly (no networking).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from '../src/wallet.js';
import { Transaction } from '../src/transaction.js';
import { Ledger } from '../src/ledger.js';
import { Mempool, MAX_TX_BYTES } from '../src/mempool.js';
import { transactionId } from '../src/consensus.js';

const alice = new Wallet();
const bob = new Wallet();
const carol = new Wallet();
const ALLOCATION = [
  { address: alice.address, amount: 100 },
  { address: bob.address, amount: 10 },
];

const ledger = new Ledger(ALLOCATION, 1);
const state = () => ledger.getState();

function pay(from, to, amount, nonce, timestamp = 1000) {
  return from.signTransaction(from.createTransaction(to.address, amount, { nonce, timestamp })).toJSON();
}

// ---------- Valid admission ----------

test('a correctly signed, affordable transaction is accepted', () => {
  const pool = new Mempool();
  const tx = pay(alice, bob, 10, 0);
  const result = pool.add(tx, state());
  assert.deepEqual(result, { status: 'accepted', id: transactionId(tx) });
  assert.equal(pool.size, 1);
  assert.equal(pool.pendingCount(alice.address), 1);
});

test('transaction IDs are deterministic across pools and object key order', () => {
  const tx = pay(alice, bob, 10, 0);
  const reordered = Object.fromEntries(Object.entries(tx).reverse());
  const a = new Mempool().add(tx, state()).id;
  const b = new Mempool().add(reordered, state()).id;
  assert.equal(a, b);
});

test('the pool keeps its own copy (mutating the caller\'s object changes nothing)', () => {
  const pool = new Mempool();
  const tx = pay(alice, bob, 10, 0);
  pool.add(tx, state());
  tx.amount = 99;
  assert.equal(pool.transactions()[0].amount, 10);
});

test('Transaction instances are accepted too', () => {
  const pool = new Mempool();
  const tx = alice.signTransaction(alice.createTransaction(bob.address, 1, { nonce: 0 }));
  assert.equal(pool.add(tx, state()).status, 'accepted');
});

test('admission does not modify the confirmed state it was given', () => {
  const s = state();
  new Mempool().add(pay(alice, bob, 10, 0), s);
  assert.equal(s.balances.get(alice.address), 100);
  assert.equal(s.nonces.get(alice.address), undefined);
});

// ---------- Invalid signatures & ownership ----------

test('an altered transaction (invalid signature) is rejected as a fault', () => {
  const tx = pay(alice, bob, 10, 0);
  tx.amount = 90;
  const result = new Mempool().add(tx, state());
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'Invalid signature');
  assert.equal(result.fault, true);
});

test('an unsigned transaction is rejected', () => {
  const tx = alice.createTransaction(bob.address, 10, { nonce: 0 }).toJSON();
  assert.equal(new Mempool().add(tx, state()).reason, 'Transaction is not signed');
});

test('sender address that does not match the public key is rejected', () => {
  const forged = new Transaction({
    sender: alice.address,
    recipient: bob.address,
    amount: 50,
    senderPublicKey: bob.publicKey,
    timestamp: 1000,
    nonce: 0,
  });
  forged.signature = bob.sign(forged.signingPayload());
  const result = new Mempool().add(forged.toJSON(), state());
  assert.equal(result.reason, 'Public key does not match sender address');
  assert.equal(result.fault, true);
});

test('malformed data is rejected without throwing', () => {
  const pool = new Mempool();
  for (const bad of [null, 'tx', 42, [], {}, { ...pay(alice, bob, 1, 0), extra: 1 }]) {
    const result = pool.add(bad, state());
    assert.equal(result.status, 'rejected');
    assert.equal(result.fault, true);
    assert.match(result.reason, /Malformed/);
  }
  assert.equal(pool.size, 0);
});

test('invalid amounts are rejected', () => {
  for (const amount of [0, -1, 1.5]) {
    const raw = alice.createTransaction(bob.address, amount, { nonce: 0, timestamp: 1000 });
    raw.signature = alice.sign(raw.signingPayload());
    assert.match(new Mempool().add(raw.toJSON(), state()).reason, /Amount must be a positive whole number/);
  }
});

test('oversized transactions are rejected before any other work', () => {
  const tx = { ...pay(alice, bob, 1, 0), signature: 'a'.repeat(MAX_TX_BYTES) };
  const result = new Mempool().add(tx, state());
  assert.match(result.reason, /exceeds 2048 bytes/);
  assert.equal(result.fault, true);
});

// ---------- Balances & reservations ----------

test('insufficient confirmed balance is rejected (not a fault)', () => {
  const result = new Mempool().add(pay(bob, alice, 11, 0), state());
  assert.match(result.reason, /Insufficient funds: balance 10, tried to send 11/);
  assert.equal(result.fault, false);
});

test('pending spends are reserved: two individually-affordable txs cannot overspend', () => {
  const pool = new Mempool();
  assert.equal(pool.add(pay(alice, bob, 60, 0), state()).status, 'accepted');
  const second = pool.add(pay(alice, carol, 60, 1), state()); // 60 ≤ 100 alone, but 120 > 100
  assert.equal(second.status, 'rejected');
  assert.match(second.reason, /Insufficient funds: balance 40, tried to send 60 \(after reserving 1 pending transaction\)/);
  assert.equal(pool.add(pay(alice, carol, 40, 1), state()).status, 'accepted'); // exactly the rest
});

test('pending INCOMING coins are not spendable (conservative policy)', () => {
  const pool = new Mempool();
  pool.add(pay(alice, carol, 50, 0), state()); // Carol will receive 50... eventually
  const result = pool.add(pay(carol, bob, 1, 0), state());
  assert.match(result.reason, /Insufficient funds: balance 0/);
});

// ---------- Duplicates & nonces ----------

test('the same transaction twice is "known", not an error', () => {
  const pool = new Mempool();
  const tx = pay(alice, bob, 10, 0);
  pool.add(tx, state());
  assert.deepEqual(pool.add(tx, state()), { status: 'known', id: transactionId(tx) });
  assert.equal(pool.size, 1);
});

test('a DIFFERENT transaction with the same sender + nonce is rejected (no replacement)', () => {
  const pool = new Mempool();
  pool.add(pay(alice, bob, 10, 0), state());
  const result = pool.add(pay(alice, carol, 5, 0), state());
  assert.match(result.reason, /Conflicts with pending transaction .* \(same sender and nonce\)/);
  assert.equal(result.fault, false);
  assert.equal(pool.size, 1);
});

test('nonce gaps are rejected', () => {
  assert.match(new Mempool().add(pay(alice, bob, 1, 1), state()).reason, /Nonce 1 skips ahead; expected 0/);
  const pool = new Mempool();
  pool.add(pay(alice, bob, 1, 0), state());
  assert.match(pool.add(pay(alice, bob, 1, 2), state()).reason, /Nonce 2 skips ahead; expected 1/);
});

test('sequential nonces are accepted', () => {
  const pool = new Mempool();
  for (let n = 0; n < 5; n++) assert.equal(pool.add(pay(alice, bob, 1, n), state()).status, 'accepted');
  assert.equal(pool.pendingCount(alice.address), 5);
});

test('a nonce already used on-chain is rejected', () => {
  const chain = new Ledger(ALLOCATION, 1);
  chain.addBlock([pay(alice, bob, 1, 0)], 5000);
  const result = new Mempool().add(pay(alice, bob, 2, 0, 2000), chain.getState());
  assert.match(result.reason, /Nonce 0 already used/);
});

test('sending to yourself is rejected', () => {
  assert.match(new Mempool().add(pay(alice, alice, 1, 0), state()).reason, /must be different/);
});

// ---------- Capacity ----------

test('total capacity is enforced', () => {
  const pool = new Mempool({ maxSize: 3 });
  for (let n = 0; n < 3; n++) pool.add(pay(alice, bob, 1, n), state());
  const result = pool.add(pay(bob, alice, 1, 0), state());
  assert.match(result.reason, /Mempool full \(3 transactions\)/);
  assert.equal(pool.size, 3);
});

test('per-sender capacity is enforced', () => {
  const pool = new Mempool({ maxPerSender: 2 });
  pool.add(pay(alice, bob, 1, 0), state());
  pool.add(pay(alice, bob, 1, 1), state());
  assert.match(pool.add(pay(alice, bob, 1, 2), state()).reason, /already has 2 pending/);
  assert.equal(pool.add(pay(bob, alice, 1, 0), state()).status, 'accepted'); // others unaffected
});

// ---------- Ordering & selection ----------

test('mining order is deterministic: by sender, then nonce', () => {
  const txs = [pay(bob, alice, 1, 0), pay(alice, bob, 1, 0), pay(alice, bob, 1, 1), pay(bob, alice, 1, 1)];
  const a = new Mempool();
  const b = new Mempool();
  for (const tx of txs) a.add(tx, state());
  for (const tx of [txs[1], txs[0], txs[2], txs[3]]) b.add(tx, state()); // different arrival order
  assert.deepEqual(a.transactions(), b.transactions());
  const order = a.transactions().map((t) => [t.sender, t.nonce]);
  const sorted = [...order].sort(([s1, n1], [s2, n2]) => (s1 === s2 ? n1 - n2 : s1 < s2 ? -1 : 1));
  assert.deepEqual(order, sorted);
});

test('selectForBlock respects the limit and the chosen txs form a valid block', () => {
  const pool = new Mempool();
  for (let n = 0; n < 4; n++) pool.add(pay(alice, bob, 1, n), state());
  pool.add(pay(bob, alice, 5, 0), state());
  const chosen = pool.selectForBlock(3);
  assert.equal(chosen.length, 3);
  const chain = new Ledger(ALLOCATION, 1);
  assert.doesNotThrow(() => chain.addBlock(pool.selectForBlock(100), 5000));
});

// ---------- Rebuild after chain changes ----------

test('rebuild removes confirmed txs and drops ones made stale by the new state', () => {
  const pool = new Mempool();
  const first = pay(alice, bob, 10, 0);
  const second = pay(alice, bob, 10, 1);
  const bobs = pay(bob, alice, 10, 0);
  for (const tx of [first, second, bobs]) pool.add(tx, state());

  // A block confirms `first`, and (elsewhere) Bob spent his coins differently.
  const chain = new Ledger(ALLOCATION, 1);
  chain.addBlock([first, pay(bob, carol, 10, 0, 7777)], 5000);
  const result = pool.rebuild(chain.getState(), { confirmedIds: new Set([transactionId(first)]) });

  assert.deepEqual(result.confirmed, [transactionId(first)]);
  assert.deepEqual(result.kept, [transactionId(second)]);
  assert.equal(result.dropped.length, 1);
  assert.equal(result.dropped[0].id, transactionId(bobs));
  assert.match(result.dropped[0].reason, /Nonce 0 already used/);
  assert.equal(pool.size, 1);
});

test('rebuild recovers valid orphaned transactions and rejects unaffordable ones', () => {
  const pool = new Mempool();
  const affordable = pay(alice, carol, 5, 0);
  const unaffordable = pay(bob, carol, 50, 0); // Bob only has 10
  const result = pool.rebuild(state(), { recover: [affordable, unaffordable, { junk: true }] });
  assert.deepEqual(result.recovered, [transactionId(affordable)]);
  assert.equal(result.dropped.length, 1);
  assert.equal(result.dropped[0].wasRecovery, true);
  assert.match(result.dropped[0].reason, /Insufficient funds/);
  assert.equal(pool.entries()[0].source, 'orphan-recovery');
});

test('rebuild is deterministic regardless of the order candidates arrive in', () => {
  const txs = [pay(alice, bob, 1, 0), pay(alice, bob, 1, 1), pay(bob, alice, 1, 0)];
  const a = new Mempool();
  const b = new Mempool();
  a.rebuild(state(), { recover: txs });
  b.rebuild(state(), { recover: [...txs].reverse() });
  assert.deepEqual(a.transactions(), b.transactions());
});

test('remove() takes transactions out and frees the sender\'s slot', () => {
  const pool = new Mempool();
  const tx = pay(alice, bob, 1, 0);
  pool.add(tx, state());
  assert.equal(pool.remove([transactionId(tx), 'missing']), 1);
  assert.equal(pool.size, 0);
  assert.equal(pool.pendingCount(alice.address), 0);
});
