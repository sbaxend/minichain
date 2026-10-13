/**
 * Demo: proof-of-work mining.
 *
 * Run with:   npm run demo:mining
 *
 * In a terminal, the demo pauses between steps — press Enter to continue.
 * When output is piped (e.g. to a file), it runs straight through.
 */
import { createInterface } from 'node:readline/promises';
import { Block } from '../src/block.js';
import { Blockchain } from '../src/blockchain.js';

// ---------- Helpers ----------

function heading(title) {
  console.log(`\n${'='.repeat(70)}\n ${title}\n${'='.repeat(70)}`);
}

/** Mine a block and measure how long it took. */
function timedMine(block, difficulty) {
  const start = performance.now();
  const attempts = block.mine(difficulty);
  const ms = performance.now() - start;
  return { attempts, ms };
}

const fmt = (n) => Math.round(n).toLocaleString('en-US');

const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
async function pause() {
  if (rl) await rl.question('\n  (press Enter to continue)');
}

const PREV = '0'.repeat(64);
const txs = { from: 'Alice', to: 'Bob', amount: 10 };

// ---------- Step 1: watch the guessing ----------

heading('STEP 1: What mining looks like — guessing nonces (difficulty 2 = "00")');
const block = new Block(1, 1000, txs, PREV);
console.log('  Same block, different nonce → completely different hash:\n');
for (let nonce = 0; nonce < 6; nonce++) {
  block.nonce = nonce;
  const hash = block.calculateHash();
  const ok = hash.startsWith('00');
  console.log(`  nonce ${String(nonce).padStart(3)} → ${hash}  ${ok ? '✅' : '❌'}`);
}
console.log('  ...keep going until the hash starts with "00"...');
await pause();

// ---------- Step 2: mine one block ----------

heading('STEP 2: Mine one block at difficulty 3 (hash must start with "000")');
const { attempts, ms } = timedMine(block, 3);
console.log(`  Attempts:      ${fmt(attempts)}`);
console.log(`  Elapsed time:  ${ms.toFixed(1)} ms`);
console.log(`  Winning nonce: ${block.nonce}`);
console.log(`  Hash:          ${block.hash}`);
console.log(`\n  Verifying takes ONE hash: hasValidProof(3) → ${block.hasValidProof(3)}`);
await pause();

// ---------- Step 3: difficulty vs effort ----------

heading('STEP 3: Each extra zero ≈ 16x more work');
const SAMPLES = 5; // mine several blocks per difficulty, because luck varies a lot
console.log(`  Mining ${SAMPLES} different blocks at each difficulty and averaging...\n`);
console.log('  Difficulty | Target prefix | Expected attempts | Avg attempts | Avg time');
console.log('  -----------+---------------+-------------------+--------------+---------');
for (let difficulty = 1; difficulty <= 4; difficulty++) {
  let totalAttempts = 0;
  let totalMs = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const b = new Block(1, 1000 + i, txs, PREV); // different timestamp → different puzzle
    const r = timedMine(b, difficulty);
    totalAttempts += r.attempts;
    totalMs += r.ms;
  }
  console.log(
    `  ${String(difficulty).padStart(10)} | ` +
      `${('"' + '0'.repeat(difficulty) + '"').padEnd(13)} | ` +
      `${fmt(16 ** difficulty).padStart(17)} | ` +
      `${fmt(totalAttempts / SAMPLES).padStart(12)} | ` +
      `${(totalMs / SAMPLES).toFixed(1).padStart(6)} ms`
  );
}
console.log('\n  "Expected" = 16^difficulty. Real averages wobble around it — mining is luck.');
console.log('  Difficulty 5 would take ~1,000,000 attempts; real Bitcoin needs ~19+ zeros.');
await pause();

// ---------- Step 4: why it matters ----------

heading('STEP 4: Why it matters — rewriting history now costs work');
const DIFFICULTY = 3;
const bc = new Blockchain(DIFFICULTY);
bc.addBlock({ from: 'Alice', to: 'Bob', amount: 10 }, 1000);
bc.addBlock({ from: 'Bob', to: 'Carol', amount: 5 }, 2000);
bc.addBlock({ from: 'Carol', to: 'Dave', amount: 2 }, 3000);
console.log(`  Built a chain at difficulty ${DIFFICULTY}. Valid? ${bc.isValid()}`);

console.log('\n  Attacker changes Block 1 (10 → 1000) and just recalculates hashes...');
bc.chain[1].data.amount = 1000;
for (let i = 1; i < bc.chain.length; i++) {
  bc.chain[i].previousHash = bc.chain[i - 1].hash;
  bc.chain[i].hash = bc.chain[i].calculateHash();
}
const r = bc.validate();
console.log(`  ❌ Rejected at block ${r.index}: ${r.reason}`);

console.log('\n  So the attacker must RE-MINE every block from 1 onward...');
let rewriteAttempts = 0;
const start = performance.now();
for (let i = 1; i < bc.chain.length; i++) {
  bc.chain[i].previousHash = bc.chain[i - 1].hash;
  rewriteAttempts += bc.chain[i].mine(DIFFICULTY);
}
const rewriteMs = performance.now() - start;
console.log(`  Re-mined ${bc.chain.length - 1} blocks: ${fmt(rewriteAttempts)} attempts, ${rewriteMs.toFixed(1)} ms`);
console.log(`  Valid now? ${bc.isValid()}`);
console.log('\n  On our laptop that\'s quick. With high difficulty and honest miners');
console.log('  adding new blocks the whole time, the attacker falls further behind');
console.log('  unless they control more mining power than everyone else combined.');

heading('Done. Mining = hard to find, easy to check.');
rl?.close();
