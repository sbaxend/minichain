/**
 * contracts.js — MiniChain's (deliberately tiny) smart contracts.
 *
 * There is NO virtual machine and NO user code. A contract is DATA: a fixed
 * template ("timelock-escrow") plus a few checked parameters. Four allow-listed
 * operations act on it, each a short, loop-free list of checks followed by ONE
 * atomic state change. That keeps execution deterministic and auditable.
 *
 * TIMELOCK ESCROW
 *   creator locks coins for a beneficiary. Let H = the height (index) of the
 *   block that contains the transaction — the ONLY notion of time used here.
 *   No wall clocks, randomness, I/O or floating point: every node replaying
 *   the same block gets the same H and therefore the same result.
 *
 *     op       signer        allowed when                               coins
 *     deploy   creator       unlockHeight > H, expiryHeight > unlock,   creator → contract
 *                            expiry − H ≤ MAX_LOCK_BLOCKS
 *     fund     creator       status 'funding', H < expiry,              creator → contract
 *                            balance + amount ≤ target amount
 *     claim    beneficiary   status 'funded', unlock ≤ H < expiry,      contract → beneficiary
 *                            amount == whole balance
 *     refund   creator       not claimed/refunded, H ≥ expiry,          contract → creator
 *                            amount == whole balance
 *
 *   The claim window [unlock, expiry) and refund window [expiry, ∞) never
 *   overlap, so for any H at most one of them is possible.
 *
 * FAILURE POLICY: a failing operation makes its transaction invalid (and so
 * any block containing it). All checks run BEFORE anything is changed, so
 * state is never partially updated.
 */
import { sha256 } from './hash.js';
import { serialize } from './serialize.js';
import { isValidAddress } from './address.js';

export const ESCROW_TEMPLATE = 'timelock-escrow';
export const CONTRACT_OPS = Object.freeze(['deploy', 'fund', 'claim', 'refund']);

// Limits (all consensus rules — every node enforces the same numbers).
export const MAX_CONTRACTS = 100; // contracts that may ever exist on one chain
export const MAX_CONTRACT_STEPS = 32; // checks/updates per operation (an op uses ≤ ~12)
export const MAX_CONTRACT_STATE_BYTES = 512; // serialized size of one contract's state
export const MAX_CONTRACT_TX_BYTES = 2048; // serialized size of a contract transaction
export const MAX_LOCK_BLOCKS = 1000; // expiry at most this many blocks after deployment
export const MAX_ESCROW_AMOUNT = 1_000_000; // same as the total-supply cap

const CONTRACT_ID_PATTERN = /^CT[0-9a-f]{40}$/;
const PARAM_KEYS = 'amount,beneficiary,expiryHeight,unlockHeight';

export const isValidContractId = (v) => typeof v === 'string' && CONTRACT_ID_PATTERN.test(v);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isHeight = (v) => Number.isSafeInteger(v) && v >= 1;

/**
 * Deterministic contract ID: "CT" + 40 hex chars of a hash over the creator,
 * their transaction nonce (never reused, so IDs are unique) and the exact
 * terms (so the same ID always means the same terms). Known before signing.
 */
export function contractIdFor({ creator, nonce, template, params }) {
  return `CT${sha256(serialize({ creator, nonce, template, params })).slice(0, 40)}`;
}

/**
 * Stateless shape check of a transaction's `contract` field.
 * @returns {string|null} Why it's malformed, or null.
 */
export function checkCallShape(call) {
  if (!isPlainObject(call)) return 'Contract call must be an object';
  if (!CONTRACT_OPS.includes(call.op)) return `Unknown contract operation (allowed: ${CONTRACT_OPS.join(', ')})`;
  const keys = Object.keys(call).sort().join();
  if (call.op !== 'deploy') {
    return keys === 'op' ? null : `A "${call.op}" call must be exactly { op }`;
  }
  if (keys !== 'op,params,template') return 'A "deploy" call must be exactly { op, template, params }';
  if (call.template !== ESCROW_TEMPLATE) return `Unknown contract template (allowed: ${ESCROW_TEMPLATE})`;
  const p = call.params;
  if (!isPlainObject(p) || Object.keys(p).sort().join() !== PARAM_KEYS) {
    return `Escrow params must be exactly { ${PARAM_KEYS.replaceAll(',', ', ')} }`;
  }
  if (!isValidAddress(p.beneficiary)) return 'Invalid beneficiary address';
  if (!Number.isSafeInteger(p.amount) || p.amount < 1 || p.amount > MAX_ESCROW_AMOUNT) {
    return `Escrow amount must be a whole number from 1 to ${MAX_ESCROW_AMOUNT}`;
  }
  if (!isHeight(p.unlockHeight) || !isHeight(p.expiryHeight)) return 'Unlock and expiry heights must be whole numbers ≥ 1';
  if (p.expiryHeight <= p.unlockHeight) return 'Expiry height must be after the unlock height';
  return null;
}

/** Deposits move coins INTO the contract; withdrawals move them OUT to the signer. */
export const isWithdrawal = (op) => op === 'claim' || op === 'refund';

/** Where a contract's coins are in its life cycle, as seen at block height `height`. */
export function contractPhase(contract, height) {
  if (contract.status === 'claimed' || contract.status === 'refunded') return contract.status;
  if (height >= contract.expiryHeight) return 'refundable';
  if (contract.status === 'funding') return 'funding';
  return height >= contract.unlockHeight ? 'claimable' : 'locked';
}

/** Thrown inside the executor; becomes the transaction's rejection reason. */
class ContractError extends Error {}

/** Counts steps and stops execution that goes over the limit. */
class StepMeter {
  constructor(max) {
    this.max = max;
    this.used = 0;
  }
  step() {
    this.used++;
    if (this.used > this.max) throw new ContractError(`Contract execution exceeded ${this.max} steps`);
  }
  require(condition, reason) {
    this.step();
    if (!condition) throw new ContractError(reason);
  }
}

/**
 * Execute one contract operation against `state` ({ balances, contracts }).
 * The caller (ledger.applyTransaction) has ALREADY checked the signature,
 * key ↔ address, and nonce. On success, coins and contract state are updated
 * together; on failure NOTHING is changed.
 *
 * @param {object} state
 * @param {import('./transaction.js').Transaction} tx
 * @param {number} height - Height of the block that contains `tx`.
 * @param {{ maxSteps?: number }} [limits]
 * @returns {string|null} Why it failed, or null on success.
 */
export function applyContractCall(state, tx, height, { maxSteps = MAX_CONTRACT_STEPS } = {}) {
  let plan;
  try {
    plan = planCall(state, tx, height, new StepMeter(maxSteps));
  } catch (err) {
    if (err instanceof ContractError) return err.message;
    throw err; // a bug, not a rule violation
  }
  // ---- Commit: the only place state changes. Contract objects are replaced,
  // never edited in place, so copies of the state never share changes.
  for (const [address, delta] of plan.balanceChanges) {
    state.balances.set(address, (state.balances.get(address) ?? 0) + delta);
  }
  state.contracts.set(plan.contract.id, Object.freeze(plan.contract));
  return null;
}

/** All the checks, no mutation. Returns what WOULD change. */
function planCall(state, tx, height, meter) {
  const { op } = tx.contract;
  const senderBalance = state.balances.get(tx.sender) ?? 0;
  meter.require(Buffer.byteLength(serialize(tx.toJSON())) <= MAX_CONTRACT_TX_BYTES,
    `Contract transaction exceeds ${MAX_CONTRACT_TX_BYTES} bytes`);

  if (op === 'deploy') {
    const { template, params } = tx.contract;
    meter.require(state.contracts.size < MAX_CONTRACTS, `Contract limit reached (${MAX_CONTRACTS} per chain)`);
    const id = contractIdFor({ creator: tx.sender, nonce: tx.nonce, template, params });
    meter.require(tx.recipient === id, 'Deploy recipient must be the contract ID derived from creator, nonce and terms');
    meter.require(!state.contracts.has(id), 'Contract already exists');
    meter.require(params.beneficiary !== tx.sender, 'Beneficiary must differ from the creator');
    meter.require(params.unlockHeight > height,
      `Unlock height ${params.unlockHeight} must be after this block (#${height})`);
    meter.require(params.expiryHeight - height <= MAX_LOCK_BLOCKS,
      `Expiry may be at most ${MAX_LOCK_BLOCKS} blocks after deployment`);
    meter.require(tx.amount <= params.amount,
      `Deposit ${tx.amount} exceeds the escrow amount ${params.amount}`);
    meter.require(tx.amount <= senderBalance, `Insufficient funds: balance ${senderBalance}, tried to deposit ${tx.amount}`);
    const contract = {
      id,
      template,
      creator: tx.sender,
      beneficiary: params.beneficiary,
      amount: params.amount,
      unlockHeight: params.unlockHeight,
      expiryHeight: params.expiryHeight,
      balance: tx.amount,
      status: tx.amount === params.amount ? 'funded' : 'funding',
      deployedAt: height,
      updatedAt: height,
    };
    meter.require(Buffer.byteLength(serialize(contract)) <= MAX_CONTRACT_STATE_BYTES,
      `Contract state exceeds ${MAX_CONTRACT_STATE_BYTES} bytes`);
    return { contract, balanceChanges: [[tx.sender, -tx.amount]] };
  }

  const current = state.contracts.get(tx.recipient);
  meter.require(current !== undefined, `Unknown contract ${tx.recipient}`);
  meter.require(current.status !== 'claimed', 'Contract already claimed');
  meter.require(current.status !== 'refunded', 'Contract already refunded');

  if (op === 'fund') {
    meter.require(tx.sender === current.creator, 'Only the creator can fund this contract');
    meter.require(current.status === 'funding', 'Contract is already fully funded');
    meter.require(height < current.expiryHeight, `Contract expired at block #${current.expiryHeight}`);
    const missing = current.amount - current.balance;
    meter.require(tx.amount <= missing, `Overfunding: only ${missing} more needed`);
    meter.require(tx.amount <= senderBalance, `Insufficient funds: balance ${senderBalance}, tried to deposit ${tx.amount}`);
    const balance = current.balance + tx.amount;
    const contract = { ...current, balance, status: balance === current.amount ? 'funded' : 'funding', updatedAt: height };
    return { contract, balanceChanges: [[tx.sender, -tx.amount]] };
  }

  if (op === 'claim') {
    meter.require(tx.sender === current.beneficiary, 'Only the beneficiary can claim this contract');
    meter.require(current.status === 'funded',
      `Insufficient funding: ${current.balance} of ${current.amount} deposited`);
    meter.require(height >= current.unlockHeight,
      `Too early: claimable from block #${current.unlockHeight}, this is block #${height}`);
    meter.require(height < current.expiryHeight, `Claim window closed at block #${current.expiryHeight}`);
    meter.require(tx.amount === current.balance, `Claim must withdraw exactly the balance (${current.balance})`);
    const contract = { ...current, balance: 0, status: 'claimed', updatedAt: height };
    return { contract, balanceChanges: [[tx.sender, current.balance]] };
  }

  // refund
  meter.require(tx.sender === current.creator, 'Only the creator can refund this contract');
  meter.require(height >= current.expiryHeight,
    `Too early to refund: refundable from block #${current.expiryHeight}, this is block #${height}`);
  meter.require(tx.amount === current.balance, `Refund must withdraw exactly the balance (${current.balance})`);
  const contract = { ...current, balance: 0, status: 'refunded', updatedAt: height };
  return { contract, balanceChanges: [[tx.sender, current.balance]] };
}
