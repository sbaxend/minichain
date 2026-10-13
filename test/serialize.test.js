import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serialize } from '../src/serialize.js';

test('field boundaries are unambiguous', () => {
  // With plain `+`, both of these would become "abc".
  assert.notEqual(serialize(['ab', 'c']), serialize(['a', 'bc']));
});

test('object key order does not matter', () => {
  assert.equal(serialize({ a: 1, b: 2 }), serialize({ b: 2, a: 1 }));
});

test('nested objects are sorted too', () => {
  assert.equal(
    serialize([{ to: 'Bob', from: 'Alice' }]),
    serialize([{ from: 'Alice', to: 'Bob' }])
  );
});

test('objects are serialized by content, not "[object Object]"', () => {
  assert.notEqual(serialize({ amount: 10 }), serialize({ amount: 11 }));
});
