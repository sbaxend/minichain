/**
 * hash.js — MiniChain's hashing utility.
 *
 * A hash function turns input of any size into a fixed-size "fingerprint".
 * SHA-256 always produces 256 bits, which we display as 64 hexadecimal characters.
 *
 * We use Node's built-in `crypto` module, so there is nothing to install.
 */
import { createHash } from 'node:crypto';

/**
 * Compute the SHA-256 hash of a string.
 *
 * @param {string} data - The text to hash.
 * @returns {string} A 64-character hexadecimal hash.
 */
export function sha256(data) {
  if (typeof data !== 'string') {
    throw new TypeError(`sha256 expects a string, got ${typeof data}`);
  }

  return createHash('sha256') // 1. choose the algorithm
    .update(data, 'utf8')     // 2. feed in the data (as UTF-8 bytes)
    .digest('hex');           // 3. finish and output as hex text
}
