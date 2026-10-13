/**
 * Demo: how SHA-256 behaves.
 *
 * Run with:   npm run demo:hash
 * Or hash your own text:   npm run demo:hash -- "your text here"
 */
import { sha256 } from '../src/hash.js';

const custom = process.argv[2];

if (custom !== undefined) {
  console.log(`Input: "${custom}"`);
  console.log(`Hash:  ${sha256(custom)}`);
  process.exit(0);
}

console.log('=== 1. Deterministic: same input → same hash ===');
console.log(sha256('hello'));
console.log(sha256('hello'));

console.log('\n=== 2. Avalanche effect: tiny change → totally different hash ===');
console.log('"hello"  →', sha256('hello'));
console.log('"Hello"  →', sha256('Hello'));
console.log('"hello!" →', sha256('hello!'));

console.log('\n=== 3. Fixed length: input size does not matter ===');
const short = sha256('a');
const long = sha256('a'.repeat(1_000_000));
console.log(`1 character         → ${short} (${short.length} chars)`);
console.log(`1,000,000 characters → ${long} (${long.length} chars)`);
