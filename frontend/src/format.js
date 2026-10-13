/**
 * format.js — small display helpers (pure functions, easy to test).
 */

/** "006a3f77…9b2c1d" — keeps the start (proof-of-work zeros) and the end. */
export function shortHash(hash, head = 10, tail = 6) {
  if (typeof hash !== 'string') return '';
  if (hash.length <= head + tail + 1) return hash;
  // Careful: slice(-0) would return the WHOLE string, so handle tail = 0 explicitly.
  return `${hash.slice(0, head)}…${tail > 0 ? hash.slice(-tail) : ''}`;
}

/** First `length` characters, for compact grids: "006a3f". */
export function hashPrefix(hash, length = 6) {
  return typeof hash === 'string' ? hash.slice(0, length) : '';
}

/** Split "00ab12" into ["00", "ab12"] so leading zeros can be highlighted. */
export function splitLeadingZeros(text) {
  const zeros = /^0*/.exec(text)[0];
  return [zeros, text.slice(zeros.length)];
}

export function formatCoins(amount) {
  return Number(amount).toLocaleString('en-US');
}

/** Work arrives as a string (it's a BigInt on the server). */
export function formatWork(work) {
  try {
    return BigInt(work).toLocaleString('en-US');
  } catch {
    return String(work);
  }
}

export function formatDateTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms === 0) return 'Fixed (genesis timestamp 0)';
  return new Date(ms).toLocaleString();
}

export function timeAgo(ms, now = Date.now()) {
  if (!Number.isFinite(ms) || ms === 0) return '';
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

/** The node with the most accumulated work (ties: the first one listed). */
export function bestNode(nodes) {
  return nodes.reduce((best, node) => (best && BigInt(best.work) >= BigInt(node.work) ? best : node), null);
}

/**
 * How a node's chain relates to the best chain:
 *   'synced'   — same tip
 *   'behind'   — its tip is an ancestor of the best tip (just missing blocks)
 *   'diverged' — its tip is on a different branch (a fork)
 *
 * Only the best node's recent blocks are known here (the API sends the last
 * 8), so a node more than 8 blocks behind is reported as 'diverged'.
 */
export function relationToBest(node, best) {
  if (!best || node.tipHash === best.tipHash) return 'synced';
  return best.recent.some((b) => b.hash === node.tipHash) ? 'behind' : 'diverged';
}
