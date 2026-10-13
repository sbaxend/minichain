/**
 * consensus.js — how a node decides which valid chain to follow.
 *
 * Plain functions with no networking, so the rules are easy to read and test.
 *
 * RULE: among VALID chains, follow the one with the most accumulated
 * proof-of-work. On a tie, keep the chain you already have.
 */
import { sha256 } from './hash.js';
import { serialize } from './serialize.js';

/**
 * Expected number of hashes needed to mine ONE block at this difficulty.
 * Each required hex zero has a 1-in-16 chance, so: 16^difficulty.
 * BigInt because real difficulties would overflow normal numbers.
 */
export function blockWork(difficulty) {
  return 16n ** BigInt(difficulty);
}

/**
 * Total expected work behind a chain (genesis counts as zero — it isn't mined).
 * Always computed from OUR difficulty, never from anything a peer claims.
 */
export function chainWork(blockchain) {
  return BigInt(blockchain.chain.length - 1) * blockWork(blockchain.difficulty);
}

/**
 * Decide whether to switch from `current` to an already-VALIDATED `candidate`.
 *
 * @returns {{ adopt: boolean, reason: string }}
 */
export function chooseChain(current, candidate) {
  const ours = chainWork(current);
  const theirs = chainWork(candidate);
  if (theirs > ours) {
    return { adopt: true, reason: `More work (${theirs} vs ${ours})` };
  }
  if (theirs < ours) {
    return { adopt: false, reason: `Less work (${theirs} vs ${ours}): keeping our chain` };
  }
  if (candidate.getLatestBlock().hash === current.getLatestBlock().hash) {
    return { adopt: false, reason: 'Already in sync' };
  }
  // Tie-break policy: first seen wins. Never switch between equally-worked
  // chains — the tie resolves itself when someone mines the next block.
  return { adopt: false, reason: `Equal work (${theirs}): keeping the chain we saw first` };
}

/** A fingerprint for a transaction, used to spot the "same" transaction in two branches. */
export function transactionId(txData) {
  return sha256(serialize(txData));
}

/**
 * Describe what changes when switching from `oldLedger` to `newLedger`.
 *
 *   old:  G ─ 1 ─ 2a              forkHeight = 1
 *   new:  G ─ 1 ─ 2b ─ 3b         removed = [2a], added = [2b, 3b]
 *
 * orphanedTransactions = transactions that were confirmed in the removed
 * blocks but are NOT in the new branch. They are no longer confirmed.
 */
export function describeReorg(oldLedger, newLedger) {
  const oldChain = oldLedger.chain;
  const newChain = newLedger.chain;
  let forkHeight = 0; // genesis is always shared (it's validated)
  while (
    forkHeight + 1 < Math.min(oldChain.length, newChain.length) &&
    oldChain[forkHeight + 1].hash === newChain[forkHeight + 1].hash
  ) {
    forkHeight++;
  }
  const removed = oldChain.slice(forkHeight + 1);
  const added = newChain.slice(forkHeight + 1);

  const addedIds = new Set(added.flatMap((b) => b.data.transactions.map(transactionId)));
  const orphanedTransactions = removed
    .flatMap((b) => b.data.transactions)
    .filter((tx) => !addedIds.has(transactionId(tx)))
    .map((tx) => structuredClone(tx));

  return {
    forkHeight,
    removedBlocks: removed.map((b) => b.hash),
    addedBlocks: added.map((b) => b.hash),
    orphanedTransactions,
  };
}
