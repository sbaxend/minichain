/**
 * block.js — a single block in MiniChain.
 *
 * A block bundles some data (e.g. a list of transactions) with:
 *   - index:        its position in the chain (0 = genesis)
 *   - timestamp:    when it was created (milliseconds since 1970)
 *   - previousHash: the hash of the block before it — this is the "chain"
 *   - nonce:        a counter changed during mining (see mine())
 *   - hash:         this block's own fingerprint, computed from all of the above
 */
import { sha256 } from './hash.js';
import { serialize } from './serialize.js';

export class Block {
  /**
   * @param {number} index        - Position in the chain.
   * @param {number} timestamp    - Creation time in ms. Passed in (not Date.now()
   *                                here) so blocks can be created deterministically.
   * @param {*}      data         - Block contents, e.g. an array of transactions.
   * @param {string} previousHash - Hash of the previous block.
   */
  constructor(index, timestamp, data, previousHash) {
    this.index = index;
    this.timestamp = timestamp;
    // Store a private copy, so changing the caller's object later can't
    // silently change what's inside the block.
    this.data = structuredClone(data);
    this.previousHash = previousHash;
    this.nonce = 0; // "number used once" — mining changes this to find a valid hash
    this.hash = this.calculateHash();
  }

  /**
   * Compute this block's hash from its fields.
   * Uses serialize() so the input is unambiguous (see serialize.js).
   * Note: `hash` itself is NOT included — a hash can't contain itself.
   */
  calculateHash() {
    return sha256(
      serialize({
        index: this.index,
        timestamp: this.timestamp,
        previousHash: this.previousHash,
        data: this.data,
        nonce: this.nonce,
      })
    );
  }

  /**
   * Proof-of-work: try nonce = 0, 1, 2, ... until the hash starts with
   * `difficulty` zeros. Each extra zero makes this ~16x slower on average,
   * because each hex character has 16 possible values.
   *
   * @param {number} difficulty - Required number of leading hex zeros (0–64).
   * @returns {number} How many hashes were tried.
   */
  mine(difficulty) {
    assertValidDifficulty(difficulty);
    this.nonce = 0;
    this.hash = this.calculateHash();
    while (!this.hasValidProof(difficulty)) {
      this.nonce++;
      this.hash = this.calculateHash();
    }
    return this.nonce + 1; // nonce started at 0, so attempts = nonce + 1
  }

  /**
   * True if the stored hash starts with `difficulty` zeros.
   * Checking takes one comparison — far cheaper than mining.
   */
  hasValidProof(difficulty) {
    return this.hash.startsWith('0'.repeat(difficulty));
  }

  /**
   * True if the stored hash still matches the block's current contents.
   * If anyone edits a field without recomputing the hash, this returns false.
   */
  isValid() {
    return this.hash === this.calculateHash();
  }

  /**
   * Plain-data copy, safe to send over the network. `data` is cloned so the
   * copy shares no objects with this block.
   */
  toJSON() {
    return {
      index: this.index,
      timestamp: this.timestamp,
      data: structuredClone(this.data),
      previousHash: this.previousHash,
      nonce: this.nonce,
      hash: this.hash,
    };
  }

  /**
   * Rebuild a Block from plain data (e.g. received from a peer).
   * Strict about shape and types. The claimed `hash` and `nonce` are copied
   * as-is — NOT trusted: chain validation recomputes and checks them.
   *
   * @throws {TypeError} if the data is malformed.
   */
  static fromJSON(json) {
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
      throw new TypeError('Block must be an object');
    }
    if (Object.keys(json).sort().join() !== BLOCK_FIELDS) {
      throw new TypeError(`Block must have exactly these fields: ${BLOCK_FIELDS}`);
    }
    const { index, timestamp, data, previousHash, nonce, hash } = json;
    for (const [name, value] of Object.entries({ index, timestamp, nonce })) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`Block ${name} must be a whole number ≥ 0`);
      }
    }
    if (!HEX64.test(previousHash) || !HEX64.test(hash)) {
      throw new TypeError('Block hashes must be 64 lowercase hex characters');
    }
    const block = new Block(index, timestamp, data, previousHash); // clones data
    block.nonce = nonce;
    block.hash = hash;
    return block;
  }
}

const BLOCK_FIELDS = 'data,hash,index,nonce,previousHash,timestamp';
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Difficulty must be a whole number from 0 to 64 (a SHA-256 hex hash has 64 characters).
 */
export function assertValidDifficulty(difficulty) {
  if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > 64) {
    throw new RangeError(`difficulty must be an integer from 0 to 64, got ${difficulty}`);
  }
}
