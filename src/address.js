/**
 * address.js — turn a public key into a short, friendly address.
 *
 *   address = "MC" + first 40 hex chars of sha256(public key)
 *
 * Deriving an address needs no secrets, so anyone (e.g. a node verifying a
 * transaction) can check that a public key belongs to a given address.
 * Because hashing is one-way, you can't go backwards from address to key.
 */
import { sha256 } from './hash.js';

const ADDRESS_PREFIX = 'MC'; // "MiniChain"
const ADDRESS_PATTERN = /^MC[0-9a-f]{40}$/;

/**
 * @param {string} publicKeyHex - A public key encoded as hex.
 * @returns {string} The address for that key.
 */
export function addressFromPublicKey(publicKeyHex) {
  return ADDRESS_PREFIX + sha256(publicKeyHex).slice(0, 40);
}

/**
 * True if `address` has the right shape ("MC" + 40 lowercase hex chars).
 * This checks format only — not that a wallet with this address exists.
 */
export function isValidAddress(address) {
  return typeof address === 'string' && ADDRESS_PATTERN.test(address);
}
