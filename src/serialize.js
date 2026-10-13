/**
 * serialize.js — turn a value into one unambiguous string before hashing.
 *
 * Why not just glue fields together with `+`?
 *   "ab" + "c"  === "abc"  ===  "a" + "bc"
 * Two different inputs, same string, same hash. That's ambiguous.
 *
 * JSON fixes this: strings are quoted and escaped, so field boundaries are
 * always clear:  ["ab","c"]  vs  ["a","bc"].
 *
 * One more catch: JSON keeps object keys in insertion order, so
 * {a:1, b:2} and {b:2, a:1} would produce different text. We sort keys
 * first so the same data always serializes the same way.
 */

/**
 * Return a copy of `value` with every object's keys in alphabetical order.
 */
function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys(value[key]);
    }
    return sorted;
  }
  return value; // strings, numbers, booleans, null
}

/**
 * Convert a value into a canonical JSON string.
 *
 * @param {*} value - Any JSON-compatible value.
 * @returns {string}
 */
export function serialize(value) {
  return JSON.stringify(sortKeys(value));
}
