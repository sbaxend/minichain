/**
 * mempool.js — a node's waiting room for signed, not-yet-mined transactions.
 *
 * "Mempool" = memory pool. Each node keeps its OWN, checks every transaction
 * itself, and never trusts another node's pool.
 *
 * Admission policy (conservative and deterministic):
 *   1. Size ≤ MAX_TX_BYTES, exact fields, valid signature + key ↔ address.
 *   2. Same transaction ID already here → "known" (fine; not re-relayed).
 *   3. Same sender + nonce already pending → rejected (no replacement).
 *   4. Pool and per-sender limits.
 *   5. Ledger rules, applied on top of the sender's OWN pending transactions:
 *        • nonce must be exactly the next one (confirmed nonce + pending count)
 *          — so no gaps, and no reuse;
 *        • amount ≤ confirmed balance − what the sender's pending txs already
 *          spend (a "reservation"). Pending INCOMING coins don't count: if the
 *          transaction paying you were dropped, your spend would become invalid.
 *
 * Mining order: by (sender, nonce, id). Every node with the same pool builds
 * the same block, and each sender's nonces stay in order.
 *
 * Contract calls follow the same policy, checked against CONFIRMED contract
 * state at the next block's height: e.g. a claim on an escrow whose funding is
 * still only pending is rejected, and a claim before the unlock height is
 * rejected (not queued) — resubmit it once it can be mined.
 */
import { Transaction } from './transaction.js';
import { applyTransaction } from './ledger.js';
import { transactionId } from './consensus.js';

// Why these numbers:
//   • 500 pending × ~450 B ≈ 225 KB, so a full pool fits in ONE sync message (1 MB cap).
//   • 25 per sender: one busy account can't fill the whole pool.
//   • 2 KB per transaction: a real one is ~450 B; anything far bigger is junk.
export const MAX_POOL_SIZE = 500;
export const MAX_PER_SENDER = 25;
export const MAX_TX_BYTES = 2048;

export class Mempool {
  #entries = new Map(); // id → { id, tx, receivedAt, source }
  #bySender = new Map(); // sender → Map(nonce → id)
  #maxSize;
  #maxPerSender;

  constructor({ maxSize = MAX_POOL_SIZE, maxPerSender = MAX_PER_SENDER } = {}) {
    this.#maxSize = maxSize;
    this.#maxPerSender = maxPerSender;
  }

  get size() {
    return this.#entries.size;
  }

  get limits() {
    return { maxSize: this.#maxSize, maxPerSender: this.#maxPerSender, maxTxBytes: MAX_TX_BYTES };
  }

  has(id) {
    return this.#entries.has(id);
  }

  /** One entry (a copy), or null. */
  get(id) {
    const entry = this.#entries.get(id);
    return entry ? { ...entry, tx: { ...entry.tx } } : null;
  }

  /** Number of pending transactions from `sender`. */
  pendingCount(sender) {
    return this.#bySender.get(sender)?.size ?? 0;
  }

  /** Every entry in deterministic (sender, nonce, id) order. Returns copies. */
  entries() {
    return [...this.#entries.values()].sort(compareEntries).map((e) => ({ ...e, tx: { ...e.tx } }));
  }

  /** Pending transactions as plain data, in mining order. */
  transactions() {
    return this.entries().map((e) => e.tx);
  }

  /**
   * Try to admit a transaction.
   *
   * @param {object} txData - Plain transaction data (or a Transaction).
   * @param {{ balances: Map, nonces: Map }} state - CONFIRMED ledger state (not modified).
   * @param {object} [meta] - { source, receivedAt } for display.
   * @returns {{ status: 'accepted'|'known'|'rejected', id?: string, reason?: string, fault?: boolean }}
   *          `fault: true` means the transaction is provably bad (malformed or
   *          badly signed) — no honest node would send it.
   */
  add(txData, state, { source = null, receivedAt = Date.now() } = {}) {
    // 1. Shape, size, signature.
    let tx;
    try {
      const raw = txData instanceof Transaction ? txData.toJSON() : txData;
      if (Buffer.byteLength(JSON.stringify(raw) ?? '') > MAX_TX_BYTES) {
        return reject(`Transaction exceeds ${MAX_TX_BYTES} bytes`, true);
      }
      tx = Transaction.fromJSON(raw);
    } catch (err) {
      return reject(`Malformed transaction: ${err.message}`, true);
    }
    const data = tx.toJSON(); // canonical copy: we never keep the caller's object
    const id = transactionId(data);

    // 2. Already have it? That's normal in gossip — not an error.
    if (this.#entries.has(id)) return { status: 'known', id };

    const check = tx.verify();
    if (!check.valid) return reject(check.reason, true, id);

    // 3. Conflicts with a different pending transaction?
    const senderTxs = this.#bySender.get(tx.sender);
    if (senderTxs?.has(tx.nonce)) {
      return reject(`Conflicts with pending transaction ${senderTxs.get(tx.nonce).slice(0, 12)}… (same sender and nonce)`, false, id);
    }

    // 4. Limits.
    if (this.#entries.size >= this.#maxSize) return reject(`Mempool full (${this.#maxSize} transactions)`, false, id);
    if ((senderTxs?.size ?? 0) >= this.#maxPerSender) {
      return reject(`Sender already has ${this.#maxPerSender} pending transactions`, false, id);
    }

    // 5. Ledger rules on top of this sender's own pending transactions.
    const reason = this.#checkAgainstState(tx.sender, data, state);
    if (reason) return reject(reason, false, id);

    this.#insert({ id, tx: data, receivedAt, source });
    return { status: 'accepted', id };
  }

  /** Remove transactions by id. Returns how many were removed. */
  remove(ids) {
    let removed = 0;
    for (const id of ids) {
      const entry = this.#entries.get(id);
      if (!entry) continue;
      this.#entries.delete(id);
      const senderTxs = this.#bySender.get(entry.tx.sender);
      senderTxs.delete(entry.tx.nonce);
      if (senderTxs.size === 0) this.#bySender.delete(entry.tx.sender);
      removed++;
    }
    return removed;
  }

  /**
   * Re-check the whole pool against a NEW confirmed state (after a block or
   * reorganization), optionally adding recovered transactions.
   *
   *   • ids in `confirmedIds` are removed (they're in the chain now)
   *   • everything else is re-admitted in (sender, nonce, id) order; anything
   *     that no longer passes is dropped, with the reason
   *
   * @param {{ balances: Map, nonces: Map }} state
   * @param {object} [options]
   * @param {Set<string>} [options.confirmedIds]
   * @param {object[]} [options.recover] - e.g. transactions from orphaned blocks.
   * @returns {{ confirmed: string[], kept: string[], recovered: string[], dropped: Array<{id, tx, reason, wasRecovery}> }}
   */
  rebuild(state, { confirmedIds = new Set(), recover = [] } = {}) {
    const previous = [...this.#entries.values()];
    const confirmed = previous.filter((e) => confirmedIds.has(e.id)).map((e) => e.id);

    const candidates = new Map(); // id → { entry, wasRecovery }
    for (const entry of previous) {
      if (!confirmedIds.has(entry.id)) candidates.set(entry.id, { entry, wasRecovery: false });
    }
    for (const tx of recover) {
      let id;
      try {
        id = transactionId(Transaction.fromJSON(tx).toJSON());
      } catch {
        continue; // malformed data can't be recovered
      }
      if (!confirmedIds.has(id) && !candidates.has(id)) {
        candidates.set(id, { entry: { id, tx, receivedAt: Date.now(), source: 'orphan-recovery' }, wasRecovery: true });
      }
    }

    this.#entries.clear();
    this.#bySender.clear();
    const kept = [];
    const recovered = [];
    const dropped = [];
    const ordered = [...candidates.values()].sort((a, b) => compareEntries(a.entry, b.entry));
    for (const { entry, wasRecovery } of ordered) {
      const result = this.add(entry.tx, state, { source: entry.source, receivedAt: entry.receivedAt });
      if (result.status === 'accepted') (wasRecovery ? recovered : kept).push(entry.id);
      else dropped.push({ id: entry.id, tx: { ...entry.tx }, reason: result.reason, wasRecovery });
    }
    return { confirmed, kept, recovered, dropped };
  }

  /**
   * Pick up to `max` transactions for a block, in mining order. Because each
   * sender's nonces are contiguous and sorted, any prefix is still valid.
   */
  selectForBlock(max) {
    return this.transactions().slice(0, max);
  }

  // ---------- private ----------

  #insert(entry) {
    this.#entries.set(entry.id, entry);
    if (!this.#bySender.has(entry.tx.sender)) this.#bySender.set(entry.tx.sender, new Map());
    this.#bySender.get(entry.tx.sender).set(entry.tx.nonce, entry.id);
  }

  /**
   * Simulate: confirmed state for this sender → apply their pending txs in
   * nonce order → apply the candidate. Uses a tiny private state so nothing
   * shared is modified, and so credits from OTHER senders never count.
   */
  #checkAgainstState(sender, data, state) {
    const sim = {
      balances: new Map([[sender, state.balances.get(sender) ?? 0]]),
      nonces: new Map([[sender, state.nonces.get(sender) ?? 0]]),
      // Contracts are CONFIRMED state only (a shallow copy: contract objects
      // are frozen and replaced, never edited, so sharing them is safe).
      contracts: new Map(state.contracts ?? []),
    };
    // A pending tx can land in the NEXT block at the earliest, so contract
    // rules (timelocks) are checked at that height. Later blocks re-check it.
    const context = { height: (state.height ?? 0) + 1 };
    const pending = [...(this.#bySender.get(sender)?.entries() ?? [])].sort(([a], [b]) => a - b);
    for (const [, id] of pending) {
      const reason = applyTransaction(sim, this.#entries.get(id).tx, context);
      if (reason) return `Pending transactions for this sender are inconsistent: ${reason}`;
    }
    const reason = applyTransaction(sim, data, context);
    if (!reason) return null;
    // Make the two pending-specific cases easier to understand.
    if (/Insufficient funds/.test(reason) && pending.length > 0) {
      return `${reason} (after reserving ${pending.length} pending transaction${pending.length > 1 ? 's' : ''})`;
    }
    return reason;
  }
}

function reject(reason, fault, id = undefined) {
  return { status: 'rejected', id, reason, fault };
}

function compareEntries(a, b) {
  if (a.tx.sender !== b.tx.sender) return a.tx.sender < b.tx.sender ? -1 : 1;
  if (a.tx.nonce !== b.tx.nonce) return a.tx.nonce - b.tx.nonce;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
