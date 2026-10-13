/**
 * Demo: account balances, double-spending, and replay protection.
 * Fictional coins only.
 *
 * Run with:   npm run demo:balances
 *
 * Private keys are never printed. In a terminal, the demo pauses between
 * steps — press Enter to continue.
 */
import { createInterface } from 'node:readline/promises';
import { Wallet } from '../src/wallet.js';
import { Block } from '../src/block.js';
import { Ledger } from '../src/ledger.js';

// ---------- Helpers ----------

function heading(title) {
  console.log(`\n${'='.repeat(70)}\n ${title}\n${'='.repeat(70)}`);
}

const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
async function pause() {
  if (rl) await rl.question('\n  (press Enter to continue)');
}

const alice = new Wallet();
const bob = new Wallet();
const charlie = new Wallet();
const people = { Alice: alice, Bob: bob, Charlie: charlie };
const nameOf = (address) =>
  Object.keys(people).find((n) => people[n].address === address) ?? address;

function printBalances(ledger) {
  for (const [name, wallet] of Object.entries(people)) {
    const balance = ledger.getBalance(wallet.address);
    const nonce = ledger.getNextNonce(wallet.address);
    console.log(`  ${name.padEnd(8)} ${String(balance).padStart(4)} coins   (next tx nonce: ${nonce})`);
  }
}

/** Alice/Bob/Charlie sign a transfer using the ledger's next nonce for them. */
function signedTransfer(from, to, amount, nonce = ledger.getNextNonce(from.address)) {
  return from.signTransaction(from.createTransaction(to.address, amount, { nonce }));
}

function describe(tx) {
  return `${nameOf(tx.sender)} → ${nameOf(tx.recipient)}: ${tx.amount} coins (tx nonce ${tx.nonce})`;
}

/** Try to add a block; print accepted/rejected. */
function submit(transactions) {
  for (const tx of transactions) console.log(`  Submitting: ${describe(tx)}`);
  try {
    const block = ledger.addBlock(transactions);
    console.log(`  ✅ ACCEPTED in block ${block.index} (mining nonce ${block.nonce}, hash ${block.hash.slice(0, 12)}…)`);
  } catch (err) {
    console.log(`  ❌ ${err.message}`);
  }
}

function printValidation() {
  const r = ledger.validate();
  console.log(r.valid ? '  ✅ Chain is VALID' : `  ❌ Chain INVALID at block ${r.index}: ${r.reason}`);
}

/** Re-link and re-mine every block from `start` on — what an attacker would do. */
function remineFrom(start) {
  for (let i = start; i < ledger.chain.length; i++) {
    ledger.chain[i].previousHash = ledger.chain[i - 1].hash;
    ledger.chain[i].mine(ledger.difficulty);
  }
  console.log(`  (re-mined blocks ${start}–${ledger.chain.length - 1}; proof-of-work is valid again)`);
}

// ---------- Step 1 ----------

heading('STEP 1: Initial allocation — Alice 100, Bob 0, Charlie 0');
const ledger = new Ledger([{ address: alice.address, amount: 100 }]);
console.log(`  Alice's address: ${alice.address}`);
console.log('  The genesis block records who starts with coins (address shown as a name):');
console.log(`  ${JSON.stringify(ledger.chain[0].data.allocation.map((a) => ({ ...a, address: nameOf(a.address) })))}`);
console.log('  It has no signature: it\'s trusted because every node agrees on this');
console.log('  exact genesis hash. It\'s the ONLY place coins are ever created.\n');
printBalances(ledger);
console.log(`\n  Total supply: ${ledger.totalSupply} coins`);
await pause();

// ---------- Step 2 ----------

heading('STEP 2: Alice signs and sends Bob 80 coins');
const aliceToBob = signedTransfer(alice, bob, 80);
submit([aliceToBob]);
await pause();

// ---------- Step 3 ----------

heading('STEP 3: Balances (recalculated by replaying the chain from genesis)');
printBalances(ledger);
await pause();

// ---------- Step 4 ----------

heading('STEP 4: Alice signs a transaction sending Charlie 80 coins');
const tooMuch = signedTransfer(alice, charlie, 80);
console.log(`  Signature valid on its own? ${tooMuch.isValid() ? 'yes' : 'no'}  ← authorization ✓`);
submit([tooMuch]);
console.log('  A valid signature proves Alice APPROVED it, not that she can AFFORD it.');
await pause();

// ---------- Step 5 ----------

heading('STEP 5: Alice sends Charlie 15 coins');
console.log('  (Alice reuses nonce 1 — the rejected transaction never used it up.)');
submit([signedTransfer(alice, charlie, 15)]);
await pause();

// ---------- Step 6 ----------

heading('STEP 6: Bob sends Charlie 30 coins');
console.log('  (Bob\'s first transaction, so his nonce is 0 — nonces are per sender.)');
submit([signedTransfer(bob, charlie, 30)]);
await pause();

// ---------- Step 7 ----------

heading('STEP 7: Final balances');
printBalances(ledger);
const total = Object.values(ledger.getBalances()).reduce((a, b) => a + b, 0);
console.log(`\n  Sum of balances: ${total} = total supply ${ledger.totalSupply}  (no coins created or lost)`);
await pause();

// ---------- Step 8 ----------

heading('STEP 8: Replay Alice\'s already-accepted "pay Bob 80" transaction');
console.log(`  Signature still valid? ${aliceToBob.isValid() ? 'yes' : 'no'} — it's a perfect copy.`);
submit([aliceToBob]);
console.log('  Its nonce (0) was used in block 1. Alice\'s next nonce is 2, so a copy');
console.log('  can never be accepted again — and the nonce is signed, so it can\'t be edited.');
await pause();

// ---------- Step 9 ----------

heading('STEP 9: Two affordable transactions that overspend TOGETHER');
console.log(`  Alice has ${ledger.getBalance(alice.address)} coins. She signs two payments of 3:`);
const n = ledger.getNextNonce(alice.address);
const pay1 = signedTransfer(alice, bob, 3, n);
const pay2 = signedTransfer(alice, charlie, 3, n + 1);
console.log('  Each one alone: 3 ≤ 5 ✓.  Together: 6 > 5 ✗\n');
console.log('  A) Through addBlock():');
submit([pay1, pay2]);

console.log('\n  B) A dishonest miner skips addBlock(), mines the block by hand, and attaches it:');
const sneaky = new Block(
  ledger.chain.length,
  Date.now(),
  { transactions: [pay1.toJSON(), pay2.toJSON()] },
  ledger.getLatestBlock().hash
);
sneaky.mine(ledger.difficulty);
ledger.chain.push(sneaky);
console.log(`  Block ${sneaky.index} has valid proof-of-work: ${sneaky.hasValidProof(ledger.difficulty)}`);
printValidation();
ledger.chain.pop();
console.log('  (Removed the invalid block. Balances unchanged.)');
await pause();

// ---------- Step 10 ----------

heading('STEP 10: Tamper with confirmed history, then re-mine');

console.log('  Attack A: change block 1 from "Alice → Bob 80" to "Alice → Bob 8".');
const original = structuredClone(ledger.chain[1].data.transactions[0]);
ledger.chain[1].data.transactions[0].amount = 8;
remineFrom(1);
printValidation();
console.log('  The amount is part of Alice\'s signature, so the edit breaks it.');

console.log('\n  (Restoring the real transaction and re-mining...)');
ledger.chain[1].data.transactions[0] = original;
remineFrom(1);
printValidation();

console.log('\n  Attack B: Alice herself re-signs block 1 as "Alice → Bob 95" (valid signature!).');
ledger.chain[1].data.transactions[0] = signedTransfer(alice, bob, 95, 0).toJSON();
remineFrom(1);
printValidation();
console.log('  Replaying history: after paying 95, Alice has 5 — so her later 15-coin');
console.log('  payment in block 2 overspends. Balance rules catch what signatures can\'t.');

heading('Done. Signatures = permission. Balances + nonces = rules. Replay = proof.');
rl?.close();
