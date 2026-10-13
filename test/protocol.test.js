import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, parseMessage, MAX_MESSAGE_BYTES } from '../src/protocol.js';

const HASH = 'a'.repeat(64);
const hello = { type: 'HELLO', nodeId: 'alice', protocol: 'minichain/1', genesisHash: HASH, difficulty: 2 };

test('valid messages parse', () => {
  for (const message of [
    hello,
    { ...hello, type: 'HELLO_ACK' },
    { type: 'NEW_BLOCK', block: {} },
    { type: 'GET_CHAIN', requestId: 1 },
    { type: 'CHAIN', requestId: 1, blocks: [] },
    { type: 'ERROR', message: 'oops' },
  ]) {
    assert.deepEqual(parseMessage(JSON.stringify(message)), { ok: true, message });
  }
});

test('encode adds exactly one trailing newline', () => {
  assert.equal(encode({ type: 'GET_CHAIN', requestId: 1 }), '{"type":"GET_CHAIN","requestId":1}\n');
});

test('encode refuses oversized messages', () => {
  assert.throws(() => encode({ type: 'ERROR', message: 'x'.repeat(MAX_MESSAGE_BYTES) }), RangeError);
});

const malformed = [
  ['not JSON', '{oops', 'Invalid JSON'],
  ['JSON array', '[1,2]', 'Message must be a JSON object'],
  ['JSON string', '"hello"', 'Message must be a JSON object'],
  ['null', 'null', 'Message must be a JSON object'],
  ['unknown type', '{"type":"MINT"}', 'Unknown message type'],
  ['inherited property as type', '{"type":"constructor"}', 'Unknown message type'],
  ['missing type', '{"requestId":1}', 'Unknown message type'],
  ['missing field', '{"type":"GET_CHAIN"}', /exactly/],
  ['claimed work smuggled in', JSON.stringify({ type: 'CHAIN', requestId: 1, blocks: [], totalWork: 1e9 }), /exactly/],
  ['claimed validity smuggled in', JSON.stringify({ type: 'NEW_BLOCK', block: {}, valid: true }), /exactly/],
  ['bad node id', JSON.stringify({ ...hello, nodeId: 'a b' }), 'HELLO: invalid nodeId'],
  ['bad genesis hash', JSON.stringify({ ...hello, genesisHash: 'xyz' }), 'HELLO: invalid genesisHash'],
  ['negative difficulty', JSON.stringify({ ...hello, difficulty: -1 }), 'HELLO: invalid difficulty'],
  ['blocks not an array', '{"type":"CHAIN","requestId":1,"blocks":{}}', 'CHAIN: invalid blocks'],
  ['block not an object', '{"type":"NEW_BLOCK","block":[]}', 'NEW_BLOCK: invalid block'],
  ['fractional request id', '{"type":"GET_CHAIN","requestId":1.5}', 'GET_CHAIN: invalid requestId'],
];
for (const [label, line, reason] of malformed) {
  test(`malformed message rejected: ${label}`, () => {
    const result = parseMessage(line);
    assert.equal(result.ok, false);
    if (reason instanceof RegExp) assert.match(result.reason, reason);
    else assert.equal(result.reason, reason);
  });
}
