/**
 * blockchain.js — an ordered list of blocks, each linked to the one before.
 *
 *   [genesis] <-- [block 1] <-- [block 2] <-- ...
 *        hash ──► previousHash
 *
 * Changing any block changes its hash, which breaks the link from the next
 * block. validate() walks the chain and finds the first such break.
 *
 * Every block after genesis must also be MINED (proof-of-work): its hash
 * must start with `difficulty` zeros. That makes rewriting history costly.
 */
import { Block, assertValidDifficulty } from './block.js';

// Low on purpose so demos and tests run quickly (~256 attempts per block).
export const DEFAULT_DIFFICULTY = 2;

// Fixed values make the genesis block identical on every computer, every run.
const GENESIS_TIMESTAMP = 0;
const GENESIS_DATA = 'MiniChain Genesis Block';
const GENESIS_PREVIOUS_HASH = '0'.repeat(64); // there is no block before it

export class Blockchain {
  /**
   * @param {number} difficulty   - Leading hex zeros required for every mined block.
   * @param {Block}  genesisBlock - Optional; lets subclasses (e.g. Ledger) use their
   *                                own fixed genesis. Defaults to the standard one.
   */
  constructor(difficulty = DEFAULT_DIFFICULTY, genesisBlock = Blockchain.createGenesisBlock()) {
    assertValidDifficulty(difficulty);
    this.difficulty = difficulty;
    // Remember which genesis this chain agreed on; validate() accepts only this hash.
    this.genesisHash = genesisBlock.hash;
    this.chain = [genesisBlock];
  }

  /**
   * Build the first block. Every call returns a block with the same hash.
   *
   * Genesis is EXEMPT from proof-of-work: it is never mined and keeps nonce 0.
   * It doesn't need to prove any work because every node hard-codes it and
   * accepts only this exact hash (see validate()).
   */
  static createGenesisBlock() {
    return new Block(0, GENESIS_TIMESTAMP, GENESIS_DATA, GENESIS_PREVIOUS_HASH);
  }

  /**
   * The most recently added block.
   */
  getLatestBlock() {
    return this.chain[this.chain.length - 1];
  }

  /**
   * Every block as plain data (e.g. to send to a peer). Shares no objects
   * with this chain, so the receiver can't affect us and vice versa.
   */
  exportBlocks() {
    return this.chain.map((block) => block.toJSON());
  }

  /**
   * Create a new block containing `data`, link it to the latest block,
   * MINE it at this chain's difficulty, and append it to the chain.
   *
   * @param {*}      data      - Block contents (e.g. array of transactions).
   * @param {number} timestamp - Optional; defaults to now. Tests pass a fixed value.
   * @returns {Block} The new (mined) block.
   */
  addBlock(data, timestamp = Date.now()) {
    const previous = this.getLatestBlock();
    const block = new Block(previous.index + 1, timestamp, data, previous.hash);
    block.mine(this.difficulty);
    this.chain.push(block);
    return block;
  }

  /**
   * Check the whole chain and report the first problem found.
   *
   * @returns {{ valid: true } | { valid: false, index: number, reason: string }}
   */
  validate() {
    // 1. The genesis block must be exactly the agreed-upon genesis block.
    //    (No proof-of-work check here — genesis is exempt, see createGenesisBlock.)
    const genesis = this.chain[0];
    if (!genesis || genesis.hash !== this.genesisHash || !genesis.isValid()) {
      return { valid: false, index: 0, reason: 'Genesis block is invalid' };
    }

    // 2. Every later block must be internally valid, mined, AND linked to its predecessor.
    for (let i = 1; i < this.chain.length; i++) {
      const block = this.chain[i];
      const previous = this.chain[i - 1];

      if (block.index !== i) {
        return { valid: false, index: i, reason: `Expected index ${i}, found ${block.index}` };
      }
      if (!block.isValid()) {
        return { valid: false, index: i, reason: 'Stored hash does not match block contents' };
      }
      if (!block.hasValidProof(this.difficulty)) {
        return {
          valid: false,
          index: i,
          reason: `Hash does not meet difficulty ${this.difficulty} (proof-of-work missing)`,
        };
      }
      if (block.previousHash !== previous.hash) {
        return { valid: false, index: i, reason: 'previousHash does not match the previous block' };
      }
    }

    return { valid: true };
  }

  /**
   * Shortcut when you only need yes/no.
   */
  isValid() {
    return this.validate().valid;
  }
}
