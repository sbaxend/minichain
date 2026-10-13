/**
 * ledger.js — a blockchain that tracks balances of FICTIONAL coins.
 *
 * Ledger extends Blockchain, so it keeps every existing check (hashes,
 * proof-of-work, links). On top of that:
 *
 *   • Genesis holds a fixed INITIAL ALLOCATION — the only way coins come into
 *     existence. Every other block must be exactly { transactions: [...] }.
 *   • Balances are never stored. They're recalculated by replaying every
 *     transaction from genesis, in order, every time we need them.
 *   • A transaction is applied only if ALL of these hold:
 *       1. well-formed and correctly signed       (Transaction.verify)
 *       2. sender ≠ recipient
 *       3. nonce = sender's next expected nonce   (replay protection)
 *       4. sender's balance ≥ amount              (no overspending)
 *
 * Legacy Blockchain chains (generic data) are unaffected: they have no
 * balances at all, so their data can never create or move coins.
 */
import { Block } from './block.js';
import { Blockchain, DEFAULT_DIFFICULTY } from './blockchain.js';
import { Transaction } from './transaction.js';
import { isValidAddress } from './address.js';
import { applyContractCall } from './contracts.js';

// Upper limit on all coins ever allocated. Keeps every balance a safe integer.
export const MAX_TOTAL_ALLOCATION = 1_000_000;

export class Ledger extends Blockchain {
  /**
   * @param {Array<{address: string, amount: number}>} allocation
   *        Starting balances, written into genesis. Checked strictly.
   * @param {number} difficulty - Proof-of-work difficulty for new blocks.
   */
  constructor(allocation, difficulty = DEFAULT_DIFFICULTY) {
    const checked = checkAllocation(allocation);
    super(difficulty, Ledger.createGenesisBlock(checked));
    this.allocation = checked; // frozen; the agreed-upon starting point
  }

  /**
   * Build the genesis block for an allocation. Deterministic: the same
   * allocation always gives the same hash, so anyone can verify it.
   */
  static createGenesisBlock(allocation) {
    const checked = checkAllocation(allocation);
    return new Block(0, 0, { allocation: checked }, '0'.repeat(64));
  }

  /**
   * Rebuild a ledger from plain block data (e.g. a chain received from a peer)
   * and fully validate it. The allocation and difficulty are OURS — whatever
   * the sender believes about them is irrelevant.
   *
   * Always returns a brand-new Ledger with brand-new Block objects.
   *
   * @throws {Error} if the blocks are malformed or the chain breaks any rule.
   */
  static fromBlocks(allocation, difficulty, blocks) {
    if (!Array.isArray(blocks) || blocks.length === 0) {
      throw new TypeError('A chain must be a non-empty array of blocks');
    }
    const ledger = new Ledger(allocation, difficulty);
    ledger.chain = blocks.map((json) => Block.fromJSON(json));
    const result = ledger.validate();
    if (!result.valid) {
      throw new Error(`Invalid chain at block ${result.index}: ${result.reason}`);
    }
    return ledger;
  }

  /** Total coins that exist. Transactions only move coins, so this never changes. */
  get totalSupply() {
    return this.allocation.reduce((sum, entry) => sum + entry.amount, 0);
  }

  /**
   * Validate the transactions, mine them into a new block, and append it.
   * Throws (and adds nothing) if any transaction breaks the rules.
   *
   * @param {Array<Transaction|object>} transactions - Applied in this order.
   * @param {number} timestamp - Optional; defaults to now.
   * @returns {Block}
   */
  addBlock(transactions, timestamp = Date.now()) {
    if (!Array.isArray(transactions)) {
      throw new TypeError('Ledger.addBlock expects an array of transactions');
    }
    const data = {
      transactions: transactions.map((tx) => (tx instanceof Transaction ? tx.toJSON() : tx)),
    };

    // Check against the current state BEFORE spending effort on mining.
    // The new block will sit at height chain.length — that's the H contracts see.
    const state = this.#currentState();
    const reason = applyBlock(state, data, this.chain.length);
    if (reason) throw new Error(`Block rejected: ${reason}`);

    return super.addBlock(data, timestamp);
  }

  /**
   * Full validation: all structural checks from Blockchain, then replay every
   * transaction from genesis. Nothing cached is trusted.
   *
   * @returns {{ valid: true } | { valid: false, index: number, reason: string }}
   */
  validate() {
    const result = this.#replay();
    if (result.valid) return { valid: true };
    return { valid: false, index: result.index, reason: result.reason };
  }

  /** Balance of an address, recalculated from the chain. */
  getBalance(address) {
    return this.#currentState().balances.get(address) ?? 0;
  }

  /** The nonce this address must use for its next transaction (0 if it has never sent). */
  getNextNonce(address) {
    return this.#currentState().nonces.get(address) ?? 0;
  }

  /**
   * Every address the chain knows about (allocated, sent, or received), with
   * its balance and next transaction nonce — computed in ONE replay.
   * Read-only: used by the explorer API.
   */
  getAccounts() {
    const { balances, nonces } = this.#currentState();
    const addresses = new Set([...balances.keys(), ...nonces.keys()]);
    return [...addresses].sort().map((address) => ({
      address,
      balance: balances.get(address) ?? 0,
      nextNonce: nonces.get(address) ?? 0,
    }));
  }

  /**
   * A fresh COPY of the confirmed state: { balances: Map, nonces: Map }.
   * Changing the copy never affects the ledger. Used by the mempool to check
   * pending transactions with exactly the same rules (see applyTransaction).
   */
  getState() {
    // #replay builds brand-new Maps every time. `height` is the tip's height,
    // so callers can tell which block a pending tx would land in (height + 1).
    return { ...this.#currentState(), height: this.chain.length - 1 };
  }

  /** Every contract's confirmed state (copies), sorted by ID. */
  getContracts() {
    return [...this.#currentState().contracts.values()]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((c) => ({ ...c }));
  }

  /** One contract's confirmed state (a copy), or null. */
  getContract(id) {
    const contract = this.#currentState().contracts.get(id);
    return contract ? { ...contract } : null;
  }

  /** All non-zero balances as a plain object { address: balance }. */
  getBalances() {
    const entries = [...this.#currentState().balances].filter(([, b]) => b > 0);
    return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : 1)));
  }

  // ---------- private ----------

  /** Replay the whole chain; return { valid, state } or { valid: false, index, reason }. */
  #replay() {
    const structural = super.validate(); // hashes, proof-of-work, links, genesis
    if (!structural.valid) return structural;

    const state = initialState(this.allocation);
    for (let i = 1; i < this.chain.length; i++) {
      const reason = applyBlock(state, this.chain[i].data, i); // block i: contracts see H = i
      if (reason) return { valid: false, index: i, reason };
    }
    return { valid: true, state };
  }

  /** State after the whole chain. Refuses to report balances from an invalid chain. */
  #currentState() {
    const result = this.#replay();
    if (!result.valid) {
      throw new Error(`Chain is invalid at block ${result.index}: ${result.reason}`);
    }
    return result.state;
  }
}

// ---------- Rules (plain functions, so they're easy to read and test) ----------

/**
 * Check an allocation and return a frozen, address-sorted copy.
 * Sorting means the same allocation always produces the same genesis block.
 */
function checkAllocation(allocation) {
  if (!Array.isArray(allocation)) {
    throw new TypeError('Allocation must be an array of { address, amount }');
  }
  const seen = new Set();
  let total = 0;
  const entries = allocation.map((entry) => {
    if (entry === null || typeof entry !== 'object' ||
        Object.keys(entry).sort().join() !== 'address,amount') {
      throw new TypeError('Each allocation entry must be exactly { address, amount }');
    }
    const { address, amount } = entry;
    if (!isValidAddress(address)) throw new TypeError(`Invalid allocation address: ${address}`);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new RangeError(`Allocation amount must be a positive whole number, got ${amount}`);
    }
    if (seen.has(address)) throw new RangeError(`Duplicate allocation address: ${address}`);
    seen.add(address);
    if (amount > MAX_TOTAL_ALLOCATION - total) {
      throw new RangeError(`Total allocation exceeds ${MAX_TOTAL_ALLOCATION}`);
    }
    total += amount;
    return Object.freeze({ address, amount });
  });
  entries.sort((a, b) => (a.address < b.address ? -1 : 1));
  return Object.freeze(entries);
}

/** Balances and nonces before any transaction: just the allocation. No contracts yet. */
function initialState(allocation) {
  const balances = new Map();
  for (const { address, amount } of allocation) balances.set(address, amount);
  return { balances, nonces: new Map(), contracts: new Map() };
}

/**
 * Apply every transaction in a block's data, IN ORDER, to `state`.
 * Each transaction sees the balances left by the ones before it.
 *
 * @param {number} height - This block's height (contracts use it as "time").
 * @returns {string|null} Why the block is invalid, or null if it's fine.
 */
function applyBlock(state, data, height) {
  const isTxBlock =
    data !== null && typeof data === 'object' && !Array.isArray(data) &&
    Object.keys(data).join() === 'transactions' &&
    Array.isArray(data.transactions) && data.transactions.length > 0;
  if (!isTxBlock) {
    return 'Block data must be exactly { transactions: [...] } with at least one transaction';
  }
  for (let j = 0; j < data.transactions.length; j++) {
    const reason = applyTransaction(state, data.transactions[j], { height });
    if (reason) return `Transaction ${j}: ${reason}`;
  }
  return null;
}

/**
 * Check one transaction against the current state and, if valid, apply it.
 * Exported so the mempool uses EXACTLY the rules blocks use.
 *
 * @param {{ balances: Map, nonces: Map, contracts: Map }} state
 * @param {object} txData
 * @param {{ height: number }} context - Height of the block the tx is (or would be) in.
 * @returns {string|null} Why it was rejected, or null if applied.
 */
export function applyTransaction(state, txData, { height } = {}) {
  let tx;
  try {
    tx = Transaction.fromJSON(txData); // strict: no missing or extra fields
  } catch (err) {
    return err.message;
  }

  // 1. Well-formed and signed by the owner of the sender address.
  const check = tx.verify();
  if (!check.valid) return check.reason;

  // 2. Sending to yourself would just burn a nonce; keep things simple and forbid it.
  if (tx.sender === tx.recipient) return 'Sender and recipient must be different';

  // 3. Replay protection: nonce must be exactly the next one for this sender.
  //    (Same rule for transfers AND contract calls — one nonce sequence per sender.)
  const expectedNonce = state.nonces.get(tx.sender) ?? 0;
  if (tx.nonce < expectedNonce) {
    return `Nonce ${tx.nonce} already used (replay?); expected ${expectedNonce}`;
  }
  if (tx.nonce > expectedNonce) {
    return `Nonce ${tx.nonce} skips ahead; expected ${expectedNonce}`;
  }

  // 3b. Contract call: the executor checks everything, then changes coins and
  //     contract state together — or nothing at all.
  if (tx.isContractCall) {
    if (!Number.isSafeInteger(height) || height < 1) return 'Contract calls need a block height';
    if (!state.contracts) return 'Contract state unavailable';
    const reason = applyContractCall(state, tx, height);
    if (reason) return reason;
    state.nonces.set(tx.sender, expectedNonce + 1);
    return null;
  }

  // 4. Enough funds?
  const balance = state.balances.get(tx.sender) ?? 0;
  if (tx.amount > balance) {
    return `Insufficient funds: balance ${balance}, tried to send ${tx.amount}`;
  }

  // All good — move the coins and use up the nonce.
  state.balances.set(tx.sender, balance - tx.amount);
  state.balances.set(tx.recipient, (state.balances.get(tx.recipient) ?? 0) + tx.amount);
  state.nonces.set(tx.sender, expectedNonce + 1);
  return null;
}
