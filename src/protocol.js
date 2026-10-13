/**
 * protocol.js — the MiniChain wire format.
 *
 * Every message is ONE line of JSON followed by "\n" (newline-delimited JSON).
 * Each message type has an exact set of fields; anything else is rejected.
 *
 *   HELLO      { nodeId, protocol, genesisHash, difficulty }  "Hi, here are my rules."
 *   HELLO_ACK  { nodeId, protocol, genesisHash, difficulty }  "Same rules — connected."
 *   NEW_BLOCK  { block }                                       "I have a new tip block."
 *   GET_CHAIN  { requestId }                                   "Send me your whole chain."
 *   CHAIN      { requestId, blocks }                           "Here it is."
 *   NEW_TX     { transaction }                                 "I accepted a new pending tx."
 *   GET_MEMPOOL { requestId }                                  "Send me your pending txs."
 *   MEMPOOL    { requestId, transactions }                     "Here they are (≤ 500)."
 *   ERROR      { message }                                     "You did something wrong."
 *
 * Note what's NOT here: no "my chain's total work", "my chain is valid" or
 * "this transaction is valid" fields. Receivers work those out themselves.
 *
 * Version 2 added the three transaction messages. Version-1 nodes don't know
 * them, so the handshake refuses to mix versions instead of failing later.
 * Version 3 added smart contracts: transactions may carry a `contract` call and
 * blocks are validated with contract rules, so v2 and v3 nodes would disagree
 * about which blocks are valid — they refuse each other at the handshake.
 */

export const PROTOCOL_VERSION = 'minichain/3';

// Biggest message we'll accept or send. Protects against memory exhaustion.
export const MAX_MESSAGE_BYTES = 1_000_000;

// Most transactions in one MEMPOOL reply. Matches the mempool's own size cap,
// so a full pool can be shared in one message (~225 KB, well under 1 MB).
export const MAX_TX_BATCH = 500;

const NODE_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export const isNodeId = (v) => typeof v === 'string' && NODE_ID_PATTERN.test(v);
const isHex64 = (v) => typeof v === 'string' && HEX64.test(v);
const isSmallInt = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const handshakeFields = {
  nodeId: isNodeId,
  protocol: (v) => typeof v === 'string' && v.length <= 32,
  genesisHash: isHex64,
  difficulty: isSmallInt,
};

// type → { field: validator }
const SCHEMAS = {
  HELLO: handshakeFields,
  HELLO_ACK: handshakeFields,
  NEW_BLOCK: { block: isPlainObject },
  GET_CHAIN: { requestId: isSmallInt },
  CHAIN: { requestId: isSmallInt, blocks: Array.isArray },
  NEW_TX: { transaction: isPlainObject },
  GET_MEMPOOL: { requestId: isSmallInt },
  MEMPOOL: { requestId: isSmallInt, transactions: (v) => Array.isArray(v) && v.length <= MAX_TX_BATCH },
  ERROR: { message: (v) => typeof v === 'string' && v.length <= 500 },
};

/**
 * Turn a message object into one line of text.
 * @throws {RangeError} if the result would exceed MAX_MESSAGE_BYTES.
 */
export function encode(message) {
  const line = JSON.stringify(message) + '\n';
  if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) {
    throw new RangeError(`Message exceeds ${MAX_MESSAGE_BYTES} bytes`);
  }
  return line;
}

/**
 * Parse and check one line. Never throws — bad input just returns a reason.
 *
 * @param {string} line
 * @returns {{ ok: true, message: object } | { ok: false, reason: string }}
 */
export function parseMessage(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'Invalid JSON' };
  }
  if (!isPlainObject(message)) return { ok: false, reason: 'Message must be a JSON object' };

  if (typeof message.type !== 'string' || !Object.hasOwn(SCHEMAS, message.type)) {
    return { ok: false, reason: 'Unknown message type' };
  }
  const schema = SCHEMAS[message.type];

  const expected = ['type', ...Object.keys(schema)].sort().join();
  if (Object.keys(message).sort().join() !== expected) {
    return { ok: false, reason: `${message.type} must have exactly: ${expected}` };
  }
  for (const [field, isValid] of Object.entries(schema)) {
    if (!isValid(message[field])) {
      return { ok: false, reason: `${message.type}: invalid ${field}` };
    }
  }
  return { ok: true, message };
}
