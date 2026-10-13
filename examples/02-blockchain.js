/**
 * Demo: building a blockchain and catching tampering.
 *
 * Run with:   npm run demo:chain
 *
 * In a terminal, the demo pauses between steps — press Enter to continue.
 * When output is piped (e.g. to a file), it runs straight through.
 */
import { createInterface } from 'node:readline/promises';
import { Blockchain } from '../src/blockchain.js';

// ---------- Helpers ----------

/** Build the same 4-block chain every time (fixed timestamps = same hashes). */
function buildChain() {
  const bc = new Blockchain();
  bc.addBlock({ from: 'Alice', to: 'Bob', amount: 10 }, 1000);
  bc.addBlock({ from: 'Bob', to: 'Carol', amount: 5 }, 2000);
  bc.addBlock({ from: 'Carol', to: 'Dave', amount: 2 }, 3000);
  return bc;
}

/** Print every block's key fields. */
function printChain(bc) {
  for (const block of bc.chain) {
    console.log(`  ┌─ Block ${block.index}`);
    console.log(`  │  Data:          ${JSON.stringify(block.data)}`);
    console.log(`  │  Nonce:         ${block.nonce}`);
    console.log(`  │  Previous hash: ${block.previousHash}`);
    console.log(`  └─ Hash:          ${block.hash}`);
  }
}

/** Run validate() and print the result in plain English. */
function printValidation(bc) {
  const result = bc.validate();
  if (result.valid) {
    console.log('  ✅ Chain is VALID');
  } else {
    console.log(`  ❌ Chain is INVALID at block ${result.index}`);
    console.log(`     Reason: ${result.reason}`);
  }
}

function heading(title) {
  console.log(`\n${'='.repeat(70)}\n ${title}\n${'='.repeat(70)}`);
}

// Pause only when a human is watching in a real terminal.
const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
async function pause() {
  if (rl) await rl.question('\n  (press Enter to continue)');
}

// ---------- Step 1: build and show the chain ----------

heading('STEP 1: Build a chain with a genesis block and 3 transactions');
let bc = buildChain();
printChain(bc);
console.log('\n  Notice: each block\'s "Previous hash" equals the "Hash" of the block above it.');
await pause();

// ---------- Step 2: validate the untouched chain ----------

heading('STEP 2: Validate the original chain');
printValidation(bc);
await pause();

// ---------- Step 3: tamper with data only ----------

heading('STEP 3: Change Block 1 data (10 → 1000) WITHOUT updating its hash');
bc.chain[1].data.amount = 1000;
console.log(`  Block 1 data is now: ${JSON.stringify(bc.chain[1].data)}`);
console.log(`  Stored hash:         ${bc.chain[1].hash}`);
console.log(`  Recalculated hash:   ${bc.chain[1].calculateHash()}`);
console.log('  → The stored hash no longer matches the contents.\n');
printValidation(bc);
await pause();

// ---------- Step 4: tamper with data AND rehash ----------

heading('STEP 4: Restore the chain, then change Block 1 AND re-mine it');
bc = buildChain(); // a fresh, untouched copy of the original chain
console.log('  Restored original chain:');
printValidation(bc);

// Since Milestone 3, a plain recalculated hash would fail proof-of-work at Block 1,
// so the attacker must re-mine Block 1 to make it look valid on its own.
console.log('\n  Now the attacker edits Block 1 and re-mines it (finds a new nonce)...');
bc.chain[1].data.amount = 1000;
bc.chain[1].mine(bc.difficulty);
console.log(`  Block 1 on its own valid?   ${bc.chain[1].isValid() ? 'yes' : 'no'}`);
console.log(`  Block 1 hash (new):         ${bc.chain[1].hash}`);
console.log(`  Block 2 previousHash (old): ${bc.chain[2].previousHash}`);
console.log('  → Block 2 still points to Block 1\'s OLD hash.\n');
printValidation(bc);

heading('Done. Changing any block breaks either its own hash or the next link.');
rl?.close();
