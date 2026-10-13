/**
 * Tests for src/hash.js, using Node's built-in test runner (no dependencies).
 * Run with: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/hash.js';

test('matches a known SHA-256 value', () => {
  // Published reference value for "hello". If this passes, our function
  // agrees with every other correct SHA-256 implementation in the world.
  assert.equal(
    sha256('hello'),
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
  );
});

test('is deterministic', () => {
  assert.equal(sha256('MiniChain'), sha256('MiniChain'));
});

test('a one-character change produces a different hash', () => {
  assert.notEqual(sha256('hello'), sha256('Hello'));
});

test('always returns 64 hex characters', () => {
  for (const input of ['', 'a', 'a much longer piece of text'.repeat(100)]) {
    assert.match(sha256(input), /^[0-9a-f]{64}$/);
  }
});

test('rejects non-string input', () => {
  assert.throws(() => sha256(123), TypeError);
});
