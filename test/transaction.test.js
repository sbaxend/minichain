import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from '../src/wallet.js';
import { Transaction } from '../src/transaction.js';

// Created once and reused: key generation is fast, but this keeps tests tidy.
const alice = new Wallet();
const bob = new Wallet();
const carol = new Wallet();

/** A fresh, properly signed Alice → Bob transaction. */
function signedTx(amount = 10) {
  return alice.signTransaction(alice.createTransaction(bob.address, amount, { timestamp: 1000 }));
}

/**
 * Build a transaction with arbitrary fields, then sign it with Alice's key
 * using the low-level sign(). Lets us test "properly signed but invalid" cases.
 */
function signedByAlice(fields) {
  const tx = new Transaction({
    sender: alice.address,
    recipient: bob.address,
    amount: 10,
    senderPublicKey: alice.publicKey,
    timestamp: 1000,
    ...fields,
  });
  tx.signature = alice.sign(tx.signingPayload());
  return tx;
}

// ---------- Valid signatures ----------

test('a transaction signed by the sender is valid', () => {
  assert.deepEqual(signedTx().verify(), { valid: true });
});

test('signing is reproducible: same transaction → same signature', () => {
  assert.equal(signedTx().signature, signedTx().signature);
});

test('signing payload excludes the signature and ignores key order', () => {
  const tx = signedTx();
  assert.doesNotMatch(tx.signingPayload(), /signature/);
  const reordered = new Transaction({
    timestamp: tx.timestamp,
    senderPublicKey: tx.senderPublicKey,
    amount: tx.amount,
    recipient: tx.recipient,
    sender: tx.sender,
  });
  assert.equal(reordered.signingPayload(), tx.signingPayload());
});

// ---------- Altered transactions ----------

for (const [field, newValue] of [
  ['amount', 1000],
  ['recipient', carol.address],
  ['timestamp', 2000],
]) {
  test(`changing ${field} after signing invalidates the signature`, () => {
    const tx = signedTx();
    tx[field] = newValue;
    assert.deepEqual(tx.verify(), { valid: false, reason: 'Invalid signature' });
  });
}

test('a signature copied from another transaction does not verify', () => {
  const original = signedTx(10);
  const other = alice.createTransaction(bob.address, 500, { timestamp: 1000 });
  other.signature = original.signature;
  assert.equal(other.verify().reason, 'Invalid signature');
});

test('a valid signature with junk appended is rejected', () => {
  const tx = signedTx();
  tx.signature += 'zz';
  assert.equal(tx.verify().reason, 'Invalid signature');
});

// ---------- Unsigned ----------

test('an unsigned transaction is rejected', () => {
  const tx = alice.createTransaction(bob.address, 10, { timestamp: 1000 });
  assert.deepEqual(tx.verify(), { valid: false, reason: 'Transaction is not signed' });
});

test('an empty-string signature counts as unsigned', () => {
  const tx = signedTx();
  tx.signature = '';
  assert.equal(tx.verify().reason, 'Transaction is not signed');
});

// ---------- Forgery ----------

test('Bob cannot forge: signing with his key while claiming Alice\'s key fails', () => {
  const forged = new Transaction({
    sender: alice.address,
    recipient: bob.address,
    amount: 50,
    senderPublicKey: alice.publicKey, // claims to be Alice...
    timestamp: 1000,
  });
  forged.signature = bob.sign(forged.signingPayload()); // ...but signs with Bob's key
  assert.deepEqual(forged.verify(), { valid: false, reason: 'Invalid signature' });
});

test('mismatched sender: Bob\'s key with Alice\'s address is rejected', () => {
  const forged = new Transaction({
    sender: alice.address,           // spend from Alice...
    recipient: bob.address,
    amount: 50,
    senderPublicKey: bob.publicKey,  // ...using Bob's key, so the signature itself is valid
    timestamp: 1000,
  });
  forged.signature = bob.sign(forged.signingPayload());
  assert.deepEqual(forged.verify(), {
    valid: false,
    reason: 'Public key does not match sender address',
  });
});

test('changing the sender address after signing is rejected', () => {
  const tx = signedTx();
  tx.sender = carol.address;
  assert.equal(tx.verify().valid, false);
});

test('a malformed public key is rejected without crashing', () => {
  const tx = signedTx();
  tx.senderPublicKey = 'not-a-key';
  assert.equal(tx.verify().valid, false);
});

// ---------- Invalid amounts ----------

for (const amount of [0, -5, 1.5, NaN, Infinity, '10', null, 2 ** 53]) {
  test(`amount ${String(amount)} (${typeof amount}) is rejected even when properly signed`, () => {
    assert.deepEqual(signedByAlice({ amount }).verify(), {
      valid: false,
      reason: 'Amount must be a positive whole number',
    });
  });
}

// ---------- Invalid addresses ----------

test('an invalid recipient address is rejected', () => {
  assert.equal(signedByAlice({ recipient: 'Bob' }).verify().reason, 'Invalid recipient address');
});

test('an invalid sender address is rejected', () => {
  assert.equal(signedByAlice({ sender: 'Alice' }).verify().reason, 'Invalid sender address');
});

// ---------- Boundary: authorization ≠ funds ----------

test('BOUNDARY: a valid signature says nothing about balance', () => {
  // Alice has no coins at all (there are no balances yet), but she can still
  // produce a correctly signed transaction for a huge amount. verify() only
  // checks authorization; balance checks come in a later milestone.
  assert.equal(signedTx(1_000_000).isValid(), true);
});

// ---------- Transaction nonce (Milestone 5) ----------

test('the transaction nonce is part of the signed payload', () => {
  const tx = alice.signTransaction(alice.createTransaction(bob.address, 10, { nonce: 3, timestamp: 1000 }));
  assert.match(tx.signingPayload(), /"nonce":3/);
  assert.ok(tx.isValid());
  tx.nonce = 4;
  assert.equal(tx.verify().reason, 'Invalid signature');
});

test('createTransaction defaults the nonce to 0', () => {
  assert.equal(alice.createTransaction(bob.address, 10).nonce, 0);
});

test('createTransaction rejects the old (recipient, amount, timestamp) form loudly', () => {
  assert.throws(() => alice.createTransaction(bob.address, 10, 1000), TypeError);
});

for (const nonce of [-1, 1.5, NaN, '0', null]) {
  test(`transaction nonce ${String(nonce)} is rejected even when properly signed`, () => {
    assert.equal(
      signedByAlice({ nonce }).verify().reason,
      'Transaction nonce must be a whole number ≥ 0'
    );
  });
}

// ---------- toJSON / fromJSON ----------

test('toJSON → fromJSON round-trips and still verifies', () => {
  const tx = signedTx();
  const copy = Transaction.fromJSON(structuredClone(tx.toJSON()));
  assert.ok(copy instanceof Transaction);
  assert.deepEqual(copy.toJSON(), tx.toJSON());
  assert.ok(copy.isValid());
});

test('fromJSON rejects extra fields (nothing unverified can ride along)', () => {
  const data = { ...signedTx().toJSON(), mint: 1_000_000 };
  assert.throws(() => Transaction.fromJSON(data), /exactly these fields/);
});

test('fromJSON rejects missing fields and non-objects', () => {
  const { nonce, ...missingNonce } = signedTx().toJSON();
  assert.throws(() => Transaction.fromJSON(missingNonce), TypeError);
  for (const bad of [null, 'tx', 42, []]) {
    assert.throws(() => Transaction.fromJSON(bad), TypeError);
  }
});
