import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Block } from '../src/block.js';

const PREV = '0'.repeat(64);
const txs = [{ from: 'Alice', to: 'Bob', amount: 10 }];

test('identical inputs produce identical hashes', () => {
  const a = new Block(1, 1000, txs, PREV);
  const b = new Block(1, 1000, txs, PREV);
  assert.equal(a.hash, b.hash);
});

test('a freshly created block is valid', () => {
  assert.ok(new Block(1, 1000, txs, PREV).isValid());
});

test('editing data without rehashing makes the block invalid', () => {
  const block = new Block(1, 1000, txs, PREV);
  block.data[0].amount = 1000;
  assert.equal(block.isValid(), false);
});

test('every field contributes to the hash', () => {
  const base = new Block(1, 1000, txs, PREV).hash;
  assert.notEqual(new Block(2, 1000, txs, PREV).hash, base);         // index
  assert.notEqual(new Block(1, 1001, txs, PREV).hash, base);         // timestamp
  assert.notEqual(new Block(1, 1000, [], PREV).hash, base);          // data
  assert.notEqual(new Block(1, 1000, txs, '1'.repeat(64)).hash, base); // previousHash
  const withNonce = new Block(1, 1000, txs, PREV);
  withNonce.nonce = 1;
  assert.notEqual(withNonce.calculateHash(), base);                    // nonce
});

test('changing the caller\'s object later does not change the block', () => {
  const myTxs = [{ from: 'Alice', to: 'Bob', amount: 10 }];
  const block = new Block(1, 1000, myTxs, PREV);
  myTxs[0].amount = 999;
  assert.equal(block.data[0].amount, 10);
  assert.ok(block.isValid());
});
