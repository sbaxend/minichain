/**
 * Demo: wallets, digital signatures, and forgery attempts. Fictional coins only.
 *
 * Run with:   npm run demo:wallets
 *
 * Private keys are never printed — they stay inside each Wallet object.
 * In a terminal, the demo pauses between steps — press Enter to continue.
 */
import { createInterface } from 'node:readline/promises';
import { Wallet } from '../src/wallet.js';
import { Transaction } from '../src/transaction.js';
import { addressFromPublicKey } from '../src/address.js';

// ---------- Helpers ----------

function heading(title) {
  console.log(`\n${'='.repeat(70)}\n ${title}\n${'='.repeat(70)}`);
}

/** Shorten long hex strings so they fit on one line. */
const short = (hex) => (hex ? `${hex.slice(0, 16)}…${hex.slice(-8)}` : '(none)');

function printTx(tx) {
  console.log(`  Sender:     ${tx.sender}`);
  console.log(`  Recipient:  ${tx.recipient}`);
  console.log(`  Amount:     ${tx.amount} fictional coins`);
  console.log(`  Public key: ${short(tx.senderPublicKey)}`);
  console.log(`  Signature:  ${short(tx.signature)}`);
}

function printVerify(tx) {
  const r = tx.verify();
  console.log(r.valid ? '  ✅ Signature VALID' : `  ❌ REJECTED: ${r.reason}`);
}

const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
async function pause() {
  if (rl) await rl.question('\n  (press Enter to continue)');
}

// ---------- Step 1 ----------

heading('STEP 1: Alice and Bob generate wallets');
const alice = new Wallet();
const bob = new Wallet();
console.log(`  Alice's address:    ${alice.address}`);
console.log(`  Alice's public key: ${short(alice.publicKey)}  (safe to share)`);
console.log(`  Bob's address:      ${bob.address}`);
console.log(`  Bob's public key:   ${short(bob.publicKey)}  (safe to share)`);
console.log('\n  Each private key stays hidden inside its wallet. Proof:');
console.log(`  Object.keys(alice) → ${JSON.stringify(Object.keys(alice))}`);
await pause();

// ---------- Step 2 ----------

heading('STEP 2: Alice creates a transaction sending Bob 10 coins');
const tx = alice.createTransaction(bob.address, 10);
printTx(tx);
console.log('\n  Not signed yet. Verifying now:');
printVerify(tx);
await pause();

// ---------- Step 3 ----------

heading('STEP 3: Alice signs the transaction with her private key');
console.log('  Exact text being signed (every field except the signature):');
console.log(`  ${tx.signingPayload().replace(alice.publicKey, short(alice.publicKey))}\n`);
alice.signTransaction(tx);
printTx(tx);
await pause();

// ---------- Step 4 ----------

heading('STEP 4: Anyone verifies Alice\'s signature');
console.log('  Check 1: hash(public key) matches sender address?');
console.log(`           ${addressFromPublicKey(tx.senderPublicKey) === tx.sender ? 'yes' : 'no'}`);
console.log('  Check 2: signature valid for this exact text and public key?');
printVerify(tx);
await pause();

// ---------- Step 5 ----------

heading('STEP 5: Bob tries to forge a transaction from Alice\'s wallet');

console.log('  Attempt A: Bob writes "Alice pays Bob 50", attaches Alice\'s public key,');
console.log('             and signs with HIS private key (he doesn\'t have hers).');
const forgedA = new Transaction({
  sender: alice.address,
  recipient: bob.address,
  amount: 50,
  senderPublicKey: alice.publicKey,
  timestamp: Date.now(),
});
forgedA.signature = bob.sign(forgedA.signingPayload());
printVerify(forgedA);

console.log('\n  Attempt B: Bob attaches HIS public key so his signature checks out...');
const forgedB = new Transaction({
  sender: alice.address,
  recipient: bob.address,
  amount: 50,
  senderPublicKey: bob.publicKey,
  timestamp: Date.now(),
});
forgedB.signature = bob.sign(forgedB.signingPayload());
printVerify(forgedB);
console.log('  ...but his key hashes to HIS address, not Alice\'s.');

console.log('\n  Attempt C: Bob asks his wallet to sign it directly:');
try {
  bob.signTransaction(alice.createTransaction(bob.address, 50));
} catch (err) {
  console.log(`  ❌ ${err.message}`);
}
await pause();

// ---------- Step 6 ----------

heading('STEP 6: Someone changes Alice\'s signed transaction from 10 to 1,000');
tx.amount = 1000;
console.log(`  Amount is now ${tx.amount}, signature unchanged: ${short(tx.signature)}`);
printVerify(tx);
console.log('  The signature was for "amount: 10". It doesn\'t match the new text.');
tx.amount = 10;
await pause();

// ---------- Step 7 ----------

heading('STEP 7: How can nodes verify Alice without knowing her private key?');
console.log(`
  Alice's private and public keys are a mathematically linked pair:

    • The PRIVATE key can CREATE signatures. Only Alice has it.
    • The PUBLIC key can only CHECK signatures. Everyone can have it.
    • Working out the private key from the public key is not practically
      possible — that's what makes Ed25519 secure.

  So a node checks two things, using only public information:
    1. sha256(public key) → matches the sender address  (key belongs to Alice)
    2. verify(text, signature, public key) → true       (Alice approved THIS text)

  ⚠️  A valid signature proves AUTHORIZATION, not FUNDS.
     Alice could sign "pay Bob 1,000,000" and it would verify — MiniChain
     doesn't track balances yet. That's a separate check, coming later.`);

heading('Done. Private key signs, public key verifies, changes break signatures.');
rl?.close();
