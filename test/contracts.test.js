/**
 * Timelock-escrow contracts: IDs, strict schemas, signatures, execution rules,
 * limits and atomicity — through the real Ledger (so block validation and
 * replay are exercised too).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from '../src/wallet.js';
import { Transaction } from '../src/transaction.js';
import { Blockchain } from '../src/blockchain.js';
import { Ledger } from '../src/ledger.js';
import { transactionId } from '../src/consensus.js';
import {
  ESCROW_TEMPLATE, MAX_CONTRACTS, MAX_LOCK_BLOCKS,
  applyContractCall, checkCallShape, contractIdFor, contractPhase, isValidContractId,
} from '../src/contracts.js';

const alice = new Wallet(); // creator
const bob = new Wallet(); // beneficiary
const carol = new Wallet(); // someone else
const ALLOCATION = [
  { address: alice.address, amount: 100 },
  { address: bob.address, amount: 100 },
  { address: carol.address, amount: 100 },
];

const sign = (wallet, tx) => wallet.signTransaction(tx);

/** Alice deploys an escrow for Bob. Heights are absolute block heights. */
function deploy({ amount = 30, deposit = amount, unlockHeight = 3, expiryHeight = 6, nonce = 0, beneficiary = bob.address } = {}) {
  return sign(alice, alice.createEscrowDeploy({ beneficiary, amount, deposit, unlockHeight, expiryHeight }, { nonce, timestamp: 1000 }));
}
const call = (wallet, id, op, amount, nonce) =>
  sign(wallet, wallet.createContractCall(id, op, amount, { nonce, timestamp: 1000 }));

/** A ledger plus helpers that track Carol's filler nonce. */
function setup() {
  const ledger = new Ledger(ALLOCATION, 1);
  let carolNonce = 0;
  return {
    ledger,
    /** Mine a block with these txs (next height = ledger.chain.length). */
    mine: (...txs) => ledger.addBlock(txs, 1000 + ledger.chain.length),
    /** Mine filler blocks (Carol pays Alice 1 coin each) until the NEXT block will have height `h`. */
    advanceTo: (h) => {
      while (ledger.chain.length < h) {
        const filler = sign(carol, carol.createTransaction(alice.address, 1, { nonce: carolNonce++, timestamp: 1 }));
        ledger.addBlock([filler], 1);
      }
    },
  };
}
const balance = (ledger, w) => ledger.getBalance(w.address);

// ---------- IDs ----------

test('contract IDs are deterministic, well-formed, and known before signing', () => {
  const unsigned = alice.createEscrowDeploy({ beneficiary: bob.address, amount: 30, deposit: 30, unlockHeight: 3, expiryHeight: 6 }, { nonce: 0 });
  const signed = deploy();
  assert.equal(unsigned.recipient, signed.recipient);
  assert.ok(isValidContractId(signed.recipient));
  const params = { beneficiary: bob.address, amount: 30, unlockHeight: 3, expiryHeight: 6 };
  const base = { creator: alice.address, nonce: 0, template: ESCROW_TEMPLATE, params };
  assert.equal(contractIdFor(base), signed.recipient);
  assert.equal(contractIdFor({ ...base, params: { ...params } }), contractIdFor(base)); // same terms
  assert.notEqual(contractIdFor({ ...base, nonce: 1 }), contractIdFor(base));
  assert.notEqual(contractIdFor({ ...base, creator: carol.address }), contractIdFor(base));
  assert.notEqual(contractIdFor({ ...base, params: { ...params, amount: 31 } }), contractIdFor(base)); // ID commits to terms
});

// ---------- Transfers are unchanged ----------

test('plain transfers carry no contract field, so their bytes, signatures and IDs are unchanged', () => {
  const tx = sign(alice, alice.createTransaction(bob.address, 5, { nonce: 0, timestamp: 1000 }));
  assert.deepEqual(Object.keys(tx.toJSON()).sort(), ['amount', 'nonce', 'recipient', 'sender', 'senderPublicKey', 'signature', 'timestamp']);
  assert.doesNotMatch(tx.signingPayload(), /contract/);
  assert.equal(tx.isContractCall, false);
  assert.ok(tx.isValid());
});

// ---------- Strict schemas & signatures ----------

const badCalls = [
  ['not an object', 'deploy'],
  ['unknown op', { op: 'mint' }],
  ['extra key on fund', { op: 'fund', amount: 5 }],
  ['deploy without params', { op: 'deploy', template: ESCROW_TEMPLATE }],
  ['unknown template', { op: 'deploy', template: 'vm', params: {} }],
  ['extra param', { op: 'deploy', template: ESCROW_TEMPLATE, params: { beneficiary: bob.address, amount: 1, unlockHeight: 2, expiryHeight: 3, code: 'x' } }],
  ['bad beneficiary', { op: 'deploy', template: ESCROW_TEMPLATE, params: { beneficiary: 'Bob', amount: 1, unlockHeight: 2, expiryHeight: 3 } }],
  ['zero amount', { op: 'deploy', template: ESCROW_TEMPLATE, params: { beneficiary: bob.address, amount: 0, unlockHeight: 2, expiryHeight: 3 } }],
  ['fractional amount', { op: 'deploy', template: ESCROW_TEMPLATE, params: { beneficiary: bob.address, amount: 1.5, unlockHeight: 2, expiryHeight: 3 } }],
  ['huge amount', { op: 'deploy', template: ESCROW_TEMPLATE, params: { beneficiary: bob.address, amount: 2_000_000, unlockHeight: 2, expiryHeight: 3 } }],
  ['expiry not after unlock', { op: 'deploy', template: ESCROW_TEMPLATE, params: { beneficiary: bob.address, amount: 1, unlockHeight: 5, expiryHeight: 5 } }],
  ['fractional height', { op: 'deploy', template: ESCROW_TEMPLATE, params: { beneficiary: bob.address, amount: 1, unlockHeight: 2.5, expiryHeight: 9 } }],
];
for (const [label, contract] of badCalls) {
  test(`malformed contract call rejected: ${label}`, () => {
    assert.ok(checkCallShape(contract));
    const tx = new Transaction({ sender: alice.address, recipient: `CT${'a'.repeat(40)}`, amount: 1, senderPublicKey: alice.publicKey, timestamp: 1, nonce: 0, contract });
    tx.signature = alice.sign(tx.signingPayload());
    assert.equal(tx.verify().valid, false);
  });
}

test('a contract call must be addressed to a contract ID; deploys to THE derived ID', () => {
  const toAddress = sign(bob, bob.createContractCall(alice.address, 'claim', 1, { nonce: 0 }));
  assert.equal(toAddress.verify().reason, 'Invalid contract ID');
  const wrongId = new Transaction({ ...deploy().toJSON(), recipient: `CT${'b'.repeat(40)}`, signature: null });
  wrongId.signature = alice.sign(wrongId.signingPayload());
  assert.match(wrongId.verify().reason, /derived from creator, nonce and terms/);
});

test('the call is signed: changing the operation or terms afterwards breaks the signature', () => {
  const claim = call(bob, `CT${'c'.repeat(40)}`, 'claim', 30, 0);
  claim.contract.op = 'refund';
  assert.equal(claim.verify().reason, 'Invalid signature');
  const dep = deploy();
  dep.contract.params.beneficiary = carol.address; // also changes the derived ID
  assert.equal(dep.verify().valid, false);
});

test('fromJSON accepts exactly the transfer fields, optionally plus `contract`', () => {
  const json = deploy().toJSON();
  assert.ok(Transaction.fromJSON(json).isValid());
  assert.throws(() => Transaction.fromJSON({ ...json, extra: 1 }), /exactly these fields/);
  assert.equal(Transaction.fromJSON({ ...json, contract: null }).verify().reason, 'Contract call must be an object');
});

// ---------- Deploy & fund ----------

test('deploy with the full amount: escrow is funded and the creator is debited', () => {
  const { ledger, mine } = setup();
  const tx = deploy({ amount: 30 });
  mine(tx); // block #1
  const c = ledger.getContract(tx.recipient);
  assert.deepEqual(
    [c.status, c.balance, c.amount, c.creator, c.beneficiary, c.deployedAt, c.unlockHeight, c.expiryHeight],
    ['funded', 30, 30, alice.address, bob.address, 1, 3, 6]
  );
  assert.equal(balance(ledger, alice), 70);
  assert.equal(ledger.getNextNonce(alice.address), 1);
});

test('partial deposit, then fund to complete; overfunding and outsiders are rejected', () => {
  const { ledger, mine } = setup();
  const tx = deploy({ amount: 30, deposit: 10 });
  mine(tx);
  assert.equal(ledger.getContract(tx.recipient).status, 'funding');
  assert.throws(() => mine(call(alice, tx.recipient, 'fund', 25, 1)), /Overfunding: only 20 more needed/);
  assert.throws(() => mine(call(carol, tx.recipient, 'fund', 5, 0)), /Only the creator can fund/);
  mine(call(alice, tx.recipient, 'fund', 20, 1));
  const c = ledger.getContract(tx.recipient);
  assert.deepEqual([c.status, c.balance], ['funded', 30]);
  assert.throws(() => mine(call(alice, tx.recipient, 'fund', 1, 2)), /already fully funded/);
});

test('invalid deployments are rejected', () => {
  const { ledger, mine } = setup();
  assert.throws(() => mine(deploy({ unlockHeight: 1, expiryHeight: 5 })), /Unlock height 1 must be after this block \(#1\)/);
  assert.throws(() => mine(deploy({ unlockHeight: 2, expiryHeight: 2 + MAX_LOCK_BLOCKS })), /at most 1000 blocks/);
  assert.throws(() => mine(deploy({ amount: 10, deposit: 11 })), /Deposit 11 exceeds the escrow amount 10/);
  assert.throws(() => mine(deploy({ amount: 500, deposit: 500 })), /Insufficient funds: balance 100, tried to deposit 500/);
  assert.throws(() => mine(deploy({ beneficiary: alice.address })), /Beneficiary must differ/);
  assert.equal(ledger.chain.length, 1); // nothing was added
  assert.deepEqual(ledger.getContracts(), []);
});

// ---------- Claim ----------

test('premature claim is rejected; at the unlock height it succeeds', () => {
  const { ledger, mine, advanceTo } = setup();
  const tx = deploy({ unlockHeight: 4, expiryHeight: 8 });
  mine(tx); // #1
  assert.throws(() => mine(call(bob, tx.recipient, 'claim', 30, 0)), /Too early: claimable from block #4, this is block #2/);
  advanceTo(4);
  mine(call(bob, tx.recipient, 'claim', 30, 0)); // #4
  const c = ledger.getContract(tx.recipient);
  assert.deepEqual([c.status, c.balance, c.updatedAt], ['claimed', 0, 4]);
  assert.equal(balance(ledger, bob), 130);
});

test('double claim, wrong amount, wrong claimant, and underfunded claims are rejected', () => {
  const { ledger, mine, advanceTo } = setup();
  const full = deploy({ unlockHeight: 2, expiryHeight: 9 });
  const partial = deploy({ amount: 50, deposit: 10, unlockHeight: 2, expiryHeight: 9, nonce: 1 });
  mine(full, partial); // #1
  assert.throws(() => mine(call(carol, full.recipient, 'claim', 30, 0)), /Only the beneficiary can claim/);
  assert.throws(() => mine(call(bob, full.recipient, 'claim', 29, 0)), /withdraw exactly the balance \(30\)/);
  assert.throws(() => mine(call(bob, partial.recipient, 'claim', 10, 0)), /Insufficient funding: 10 of 50 deposited/);
  mine(call(bob, full.recipient, 'claim', 30, 0)); // #2
  assert.throws(() => mine(call(bob, full.recipient, 'claim', 30, 1)), /already claimed/);
  assert.equal(balance(ledger, bob), 130);
});

test('the claim window closes at the expiry height', () => {
  const { mine, advanceTo } = setup();
  const tx = deploy({ unlockHeight: 2, expiryHeight: 4 });
  mine(tx);
  advanceTo(4);
  assert.throws(() => mine(call(bob, tx.recipient, 'claim', 30, 0)), /Claim window closed at block #4/);
});

// ---------- Refund ----------

test('refund: only the creator, only from the expiry height, and never after a claim', () => {
  const { ledger, mine, advanceTo } = setup();
  const tx = deploy({ unlockHeight: 2, expiryHeight: 4 });
  mine(tx); // #1
  assert.throws(() => mine(call(alice, tx.recipient, 'refund', 30, 1)), /Too early to refund: refundable from block #4, this is block #2/);
  advanceTo(4);
  assert.throws(() => mine(call(bob, tx.recipient, 'refund', 30, 0)), /Only the creator can refund/);
  mine(call(alice, tx.recipient, 'refund', 30, 1)); // #4
  assert.equal(ledger.getContract(tx.recipient).status, 'refunded');
  assert.equal(balance(ledger, alice), 100 + 2); // got her 30 back (+2 filler coins from Carol)
  assert.throws(() => mine(call(bob, tx.recipient, 'claim', 30, 0)), /already refunded/);
  assert.throws(() => mine(call(alice, tx.recipient, 'refund', 30, 2)), /already refunded/);
});

test('an underfunded escrow can still be refunded after expiry', () => {
  const { ledger, mine, advanceTo } = setup();
  const tx = deploy({ amount: 50, deposit: 10, unlockHeight: 2, expiryHeight: 3 });
  mine(tx);
  advanceTo(3);
  mine(call(alice, tx.recipient, 'refund', 10, 1));
  assert.equal(ledger.getContract(tx.recipient).status, 'refunded');
});

test('calls on an unknown contract are rejected', () => {
  const { mine } = setup();
  assert.throws(() => mine(call(bob, `CT${'d'.repeat(40)}`, 'claim', 1, 0)), /Unknown contract/);
});

// ---------- Nonces, replay, conservation, determinism ----------

test('contract calls and transfers share ONE nonce sequence per sender; replays fail', () => {
  const { ledger, mine } = setup();
  const tx = deploy({ nonce: 0 });
  mine(tx, sign(alice, alice.createTransaction(carol.address, 5, { nonce: 1, timestamp: 1 })));
  assert.equal(ledger.getNextNonce(alice.address), 2);
  assert.throws(() => mine(tx), /Nonce 0 already used/);
});

test('coins are conserved: account balances + coins locked in contracts = total supply', () => {
  const { ledger, mine } = setup();
  mine(deploy({ amount: 30 }), deploy({ amount: 40, deposit: 15, nonce: 1 }));
  const accounts = ledger.getAccounts().reduce((s, a) => s + a.balance, 0);
  const locked = ledger.getContracts().reduce((s, c) => s + c.balance, 0);
  assert.equal(locked, 45);
  assert.equal(accounts + locked, ledger.totalSupply);
});

test('independent replays of the same blocks derive identical contract state', () => {
  const { ledger, mine } = setup();
  const tx = deploy({ unlockHeight: 2, expiryHeight: 5 });
  mine(tx);
  mine(call(bob, tx.recipient, 'claim', 30, 0));
  const copyA = Ledger.fromBlocks(ALLOCATION, 1, ledger.exportBlocks());
  const copyB = Ledger.fromBlocks(ALLOCATION, 1, structuredClone(ledger.exportBlocks()));
  assert.deepEqual(copyA.getContracts(), ledger.getContracts());
  assert.deepEqual(copyB.getContracts(), ledger.getContracts());
});

// ---------- Invalid blocks ----------

test('a block with a premature claim that bypasses addBlock makes the chain invalid', () => {
  const { ledger, mine } = setup();
  const tx = deploy({ unlockHeight: 5, expiryHeight: 9 });
  mine(tx);
  Blockchain.prototype.addBlock.call(ledger, { transactions: [call(bob, tx.recipient, 'claim', 30, 0).toJSON()] });
  assert.deepEqual(ledger.validate(), {
    valid: false,
    index: 2,
    reason: 'Transaction 0: Too early: claimable from block #5, this is block #2',
  });
  assert.throws(() => Ledger.fromBlocks(ALLOCATION, 1, ledger.exportBlocks()), /Invalid chain at block 2/);
});

test('one bad contract call invalidates its whole block (no partial application)', () => {
  const { ledger, mine } = setup();
  const tx = deploy({ unlockHeight: 5, expiryHeight: 9 });
  assert.throws(() => mine(tx, call(bob, tx.recipient, 'claim', 30, 0)), /Transaction 1: Too early/);
  assert.equal(ledger.getContract(tx.recipient), null); // the deploy did NOT happen either
  assert.equal(balance(ledger, alice), 100);
});

// ---------- Executor limits & atomicity ----------

function freshState() {
  return { balances: new Map([[alice.address, 100], [bob.address, 100]]), nonces: new Map(), contracts: new Map() };
}
const snapshot = (s) => JSON.stringify([[...s.balances], [...s.contracts]]);

test('execution stops at the step limit and changes nothing', () => {
  const state = freshState();
  const before = snapshot(state);
  assert.equal(applyContractCall(state, deploy(), 1, { maxSteps: 3 }), 'Contract execution exceeded 3 steps');
  assert.equal(snapshot(state), before);
  assert.equal(applyContractCall(state, deploy(), 1), null); // the default limit is enough
});

test('a failing operation leaves balances and contracts exactly as they were', () => {
  const state = freshState();
  applyContractCall(state, deploy({ unlockHeight: 5, expiryHeight: 9 }), 1);
  const before = snapshot(state);
  const id = deploy({ unlockHeight: 5, expiryHeight: 9 }).recipient;
  assert.match(applyContractCall(state, call(bob, id, 'claim', 30, 0), 2), /Too early/);
  assert.equal(snapshot(state), before);
});

test('the contract-count limit is enforced', () => {
  const state = freshState();
  for (let i = 0; i < MAX_CONTRACTS; i++) state.contracts.set(`CT${String(i).padStart(40, '0')}`, Object.freeze({}));
  assert.match(applyContractCall(state, deploy(), 1), /Contract limit reached \(100 per chain\)/);
});

test('a contract cannot be deployed twice', () => {
  const state = freshState();
  const tx = deploy();
  assert.equal(applyContractCall(state, tx, 1), null);
  assert.equal(applyContractCall(state, tx, 1), 'Contract already exists');
});

test('contract objects in state are frozen and replaced, never edited in place', () => {
  const state = freshState();
  const tx = deploy({ amount: 30, deposit: 10 });
  applyContractCall(state, tx, 1);
  const before = state.contracts.get(tx.recipient);
  assert.ok(Object.isFrozen(before));
  applyContractCall(state, call(alice, tx.recipient, 'fund', 20, 1), 2);
  assert.equal(before.balance, 10); // the old object is untouched
  assert.equal(state.contracts.get(tx.recipient).balance, 30);
});

test('contractPhase describes the life cycle at a given height', () => {
  const c = { status: 'funded', unlockHeight: 3, expiryHeight: 6 };
  assert.equal(contractPhase(c, 2), 'locked');
  assert.equal(contractPhase(c, 3), 'claimable');
  assert.equal(contractPhase(c, 6), 'refundable');
  assert.equal(contractPhase({ ...c, status: 'funding' }, 4), 'funding');
  assert.equal(contractPhase({ ...c, status: 'claimed' }, 9), 'claimed');
});

test('contract transaction IDs are stable and include the call', () => {
  const a = deploy().toJSON();
  const b = deploy().toJSON();
  assert.equal(transactionId(a), transactionId(b));
  assert.notEqual(transactionId(a), transactionId(deploy({ amount: 31 }).toJSON()));
});
