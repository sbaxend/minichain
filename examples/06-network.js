/**
 * Demo: three MiniChain nodes on your computer — networking, forks, and consensus.
 * Fictional coins only. Everything runs on 127.0.0.1 (local-only).
 *
 * Run with:   npm run demo:network
 *
 * In a terminal, the demo pauses between steps — press Enter to continue.
 */
import { createInterface } from 'node:readline/promises';
import { once } from 'node:events';
import { Wallet } from '../src/wallet.js';
import { Transaction } from '../src/transaction.js';
import { Block } from '../src/block.js';
import { Blockchain } from '../src/blockchain.js';
import { Ledger } from '../src/ledger.js';
import { Node } from '../src/node.js';
import { chainWork } from '../src/consensus.js';

// ---------- Helpers ----------

function heading(title) {
  console.log(`\n${'='.repeat(72)}\n ${title}\n${'='.repeat(72)}`);
}
const say = (text) => console.log(`  ${text}`);
const short = (hash) => hash.slice(0, 8);

const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
async function pause() {
  if (rl) await rl.question('\n  (press Enter to continue)');
}

/** Wait for an event, but give up after 5 s instead of hanging. */
const waitFor = (emitter, event) => once(emitter, event, { signal: AbortSignal.timeout(5000) });

// Wallets (fictional coins). Each person also runs a node with the same name.
const wallets = { Alice: new Wallet(), Bob: new Wallet(), Charlie: new Wallet() };
const ALLOCATION = Object.values(wallets).map((w) => ({ address: w.address, amount: 100 }));
const nameOf = (address) => Object.keys(wallets).find((n) => wallets[n].address === address) ?? 'Mallory';

function transfer(from, to, amount, node) {
  const sender = wallets[from];
  const nonce = node.ledger.getNextNonce(sender.address);
  return sender.signTransaction(sender.createTransaction(wallets[to].address, amount, { nonce }));
}

function printChains(nodes) {
  for (const node of nodes) {
    const hashes = node.ledger.chain.map((b, i) => (i === 0 ? 'genesis' : short(b.hash)));
    say(`${node.id.padEnd(8)} ${hashes.join(' ─ ')}`);
  }
}

function printBalances(nodes) {
  say(`${'node'.padEnd(8)} height  tip       work   Alice  Bob  Charlie`);
  for (const node of nodes) {
    const [a, b, c] = Object.values(wallets).map((w) => String(node.getBalance(w.address)));
    say(
      `${node.id.padEnd(8)} ${String(node.height).padStart(6)}  ${short(node.tipHash)}  ` +
        `${String(chainWork(node.ledger)).padStart(4)}   ${a.padStart(5)}  ${b.padStart(3)}  ${c.padStart(7)}`
    );
  }
}

const nodes = ['alice', 'bob', 'charlie'].map(
  (id) => new Node({ id, allocation: ALLOCATION, difficulty: 2 })
);
const [alice, bob, charlie] = nodes;
const extraNodes = []; // malicious nodes from Step 10, stopped at the end

try {
  // ---------- Step 1 ----------
  heading('STEP 1: Start three independent nodes');
  for (const node of nodes) {
    await node.start();
    say(`${node.id.padEnd(8)} listening on 127.0.0.1:${node.port}  (own ledger, own peers)`);
  }
  say('');
  say('Each node is a separate participant with its OWN copy of the blockchain.');
  say('Nothing is shared — they can only learn things by sending messages.');
  await pause();

  // ---------- Step 2 ----------
  heading('STEP 2: Same genesis allocation and consensus rules; connect as peers');
  say('Genesis allocation: Alice 100, Bob 100, Charlie 100 (fictional coins)');
  for (const node of nodes) {
    const p = node.consensusParams;
    say(`${node.id.padEnd(8)} protocol ${p.protocol}  genesis ${short(p.genesisHash)}…  difficulty ${p.difficulty}`);
  }
  await alice.connect(bob.port);
  await alice.connect(charlie.port);
  await bob.connect(charlie.port);
  say('');
  for (const node of nodes) say(`${node.id.padEnd(8)} peers: ${node.peerIds.join(', ')}`);
  say('');
  say('A peer is a node you are directly connected to. During the handshake each');
  say('side checks the other uses the same genesis + difficulty, or refuses.');
  await pause();

  // ---------- Step 3 ----------
  heading('STEP 3: Everyone agrees on the genesis block');
  printChains(nodes);
  say('');
  say(`Same genesis hash on all three? ${new Set(nodes.map((n) => n.tipHash)).size === 1 ? 'yes ✅' : 'no ❌'}`);
  await pause();

  // ---------- Step 4 ----------
  heading('STEP 4: Charlie goes offline (disconnects from everyone)');
  await Promise.all([waitFor(alice, 'peerDisconnected'), waitFor(bob, 'peerDisconnected'), charlie.disconnectAll()]);
  for (const node of nodes) say(`${node.id.padEnd(8)} peers: ${node.peerIds.join(', ') || '(none)'}`);
  await pause();

  // ---------- Step 5 ----------
  heading('STEP 5: Alice and Bob keep mining — blocks propagate between them');
  let arrived = waitFor(bob, 'chainUpdated');
  alice.mineBlock([transfer('Alice', 'Bob', 10, alice)]);
  await arrived;
  say(`alice mined block 1 (Alice → Bob 10). bob received it, validated it, adopted it.`);
  arrived = waitFor(alice, 'chainUpdated');
  bob.mineBlock([transfer('Bob', 'Alice', 5, bob)]);
  await arrived;
  say(`bob mined block 2 (Bob → Alice 5). alice received it, validated it, adopted it.`);
  say('');
  say('That is NETWORK PROPAGATION: a node mines, tells its peers, they check');
  say('the block themselves and pass it on.');
  await pause();

  // ---------- Step 6 ----------
  heading('STEP 6: Meanwhile, offline Charlie mines his own block — a FORK');
  charlie.mineBlock([transfer('Charlie', 'Alice', 20, charlie)]);
  say('charlie mined block 1 (Charlie → Alice 20) on his own.\n');
  printChains(nodes);
  say('');
  say('Same genesis, different histories after it. Both branches are VALID.');
  say('Notice the nodes now disagree about balances:\n');
  printBalances(nodes);
  await pause();

  // ---------- Step 7 ----------
  heading('STEP 7: Charlie reconnects and synchronizes');
  await charlie.connect(alice.port);
  await charlie.connect(bob.port);
  say(`charlie peers: ${charlie.peerIds.join(', ')}`);
  const reorgSeen = waitFor(charlie, 'reorg');
  const results = await charlie.sync();
  for (const r of results) {
    say(`from ${r.peer.padEnd(6)} → ${r.adopted ? 'ADOPTED' : 'kept ours'}: ${r.reason}`);
  }
  await pause();

  // ---------- Step 8 ----------
  heading('STEP 8: Charlie validated the stronger chain and REORGANIZED');
  const [reorg] = await reorgSeen;
  say(`Fork point: height ${reorg.forkHeight} (genesis)`);
  say(`Abandoned:  ${reorg.removedBlocks.map(short).join(', ')}  (Charlie's own block)`);
  say(`Adopted:    ${reorg.addedBlocks.map(short).join(', ')}`);
  say('');
  say('Before switching, Charlie re-checked EVERYTHING himself: genesis, hashes,');
  say('links, proof-of-work, signatures, nonces, balances. Then he compared work:');
  say('2 blocks × 16² = 512 beats 1 block × 16² = 256. More work wins.');
  say('');
  say(`Orphaned transactions (were confirmed on the abandoned branch, aren't now):`);
  for (const tx of reorg.orphanedTransactions) {
    say(`  ${nameOf(tx.sender)} → ${nameOf(tx.recipient)} ${tx.amount} (tx nonce ${tx.nonce})`);
  }
  say(`Charlie's balance is back to ${charlie.getBalance(wallets.Charlie.address)} — recalculated from the adopted chain.`);
  say('');
  say('Nobody else has that payment, so Charlie must SUBMIT IT AGAIN. It still');
  say('works (his nonce 0 is unused on this chain). If it had conflicted — say');
  say('he\'d spent those coins elsewhere — it would now be rejected for good.\n');
  const both = [waitFor(alice, 'chainUpdated'), waitFor(bob, 'chainUpdated')];
  charlie.mineBlock(reorg.orphanedTransactions);
  await Promise.all(both);
  say('charlie re-mined it as block 3; alice and bob validated and adopted it.');
  await pause();

  // ---------- Step 9 ----------
  heading('STEP 9: All three nodes agree');
  printChains(nodes);
  say('');
  printBalances(nodes);
  const agree = new Set(nodes.map((n) => n.tipHash)).size === 1;
  say('');
  say(`Same tip on every node? ${agree ? 'yes ✅  This is CONSENSUS.' : 'no ❌'}`);
  await pause();

  // ---------- Step 10 ----------
  heading('STEP 10: A malicious peer sends LONGER but INVALID chains');
  const mallory = new Wallet();
  const honestTip = alice.tipHash;

  /** Start an attacker node, give it a forged ledger, announce it to alice. */
  async function attack(label, buildForged) {
    const evil = new Node({ id: `mallory-${extraNodes.length + 1}`, allocation: ALLOCATION, difficulty: 2 });
    extraNodes.push(evil);
    await evil.start();
    evil.ledger = buildForged(Ledger.fromBlocks(ALLOCATION, 2, alice.ledger.exportBlocks()));
    await evil.connect(alice.port);
    const rejected = waitFor(alice, 'chainRejected');
    const dropped = waitFor(alice, 'peerDisconnected');
    evil.announceTip();
    const [{ reason }] = await rejected;
    await dropped;
    say(`${label}`);
    say(`  forged chain height ${evil.height} vs honest ${alice.height}  (more blocks!)`);
    say(`  ❌ alice: ${reason}`);
    say(`  → alice disconnected ${evil.id}. Her tip is unchanged: ${alice.tipHash === honestTip ? 'yes' : 'NO'}\n`);
  }

  /** Append blocks WITHOUT the ledger's rules (but with valid proof-of-work). */
  const appendUnchecked = (ledger, tx) =>
    Blockchain.prototype.addBlock.call(ledger, { transactions: [tx.toJSON()] });

  await attack('A) Forged signature: "Alice → Mallory 90", signed with Mallory\'s key', (forged) => {
    // Read the nonce BEFORE forging: once a forged block is appended, the
    // ledger (correctly) refuses to report state from an invalid chain.
    const firstNonce = forged.getNextNonce(wallets.Alice.address);
    for (let i = 0; i < 2; i++) {
      const tx = new Transaction({
        sender: wallets.Alice.address,
        recipient: mallory.address,
        amount: 90,
        senderPublicKey: wallets.Alice.publicKey,
        timestamp: Date.now(),
        nonce: firstNonce + i,
      });
      tx.signature = mallory.sign(tx.signingPayload());
      appendUnchecked(forged, tx);
    }
    return forged;
  });

  await attack('B) Insufficient funds: Mallory (0 coins) sends Bob 1,000 — correctly signed', (forged) => {
    for (let nonce = 0; nonce < 2; nonce++) {
      appendUnchecked(forged, mallory.signTransaction(mallory.createTransaction(wallets.Bob.address, 1000, { nonce })));
    }
    return forged;
  });

  await attack('C) No proof-of-work: blocks attached without mining', (forged) => {
    for (let i = 0; i < 2; i++) {
      const tip = forged.getLatestBlock();
      const block = new Block(tip.index + 1, Date.now(), { transactions: [] }, tip.hash);
      while (block.hasValidProof(forged.difficulty)) { // make sure it does NOT meet difficulty
        block.nonce++;
        block.hash = block.calculateHash();
      }
      forged.chain.push(block);
    }
    return forged;
  });

  say('Length alone means nothing: an invalid chain has NO valid work, however long.');

  heading('Done. Independent nodes + validation + most-work rule = shared history.');
} finally {
  await Promise.all([...nodes, ...extraNodes].map((n) => n.stop()));
  rl?.close();
}
