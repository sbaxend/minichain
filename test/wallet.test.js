import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { Wallet } from '../src/wallet.js';
import { addressFromPublicKey, isValidAddress } from '../src/address.js';

test('a wallet has a well-formed address derived from its public key', () => {
  const w = new Wallet();
  assert.ok(isValidAddress(w.address), w.address);
  assert.equal(w.address, addressFromPublicKey(w.publicKey));
});

test('different wallets get different keys and addresses', () => {
  const a = new Wallet();
  const b = new Wallet();
  assert.notEqual(a.publicKey, b.publicKey);
  assert.notEqual(a.address, b.address);
});

test('the private key is not exposed', () => {
  const w = new Wallet();
  assert.deepEqual(Object.keys(w).sort(), ['address', 'publicKey']);
  assert.equal(w.privateKey, undefined);
  assert.doesNotMatch(JSON.stringify(w), /private/i);
  assert.doesNotMatch(inspect(w), /private/i);
});

test('Ed25519 signatures are deterministic', () => {
  const w = new Wallet();
  assert.equal(w.sign('hello'), w.sign('hello'));
  assert.notEqual(w.sign('hello'), w.sign('hello!'));
});

test('sign() rejects non-string messages', () => {
  assert.throws(() => new Wallet().sign({ amount: 10 }), TypeError);
});

test('createTransaction fills in sender and public key, unsigned', () => {
  const alice = new Wallet();
  const bob = new Wallet();
  const tx = alice.createTransaction(bob.address, 10, { timestamp: 1000 });
  assert.equal(tx.sender, alice.address);
  assert.equal(tx.senderPublicKey, alice.publicKey);
  assert.equal(tx.recipient, bob.address);
  assert.equal(tx.signature, null);
});

test('a wallet refuses to sign a transaction spending from another wallet', () => {
  const alice = new Wallet();
  const bob = new Wallet();
  const tx = alice.createTransaction(bob.address, 10, { timestamp: 1000 });
  assert.throws(() => bob.signTransaction(tx), /another wallet/);
});
