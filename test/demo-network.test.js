/**
 * The explorer's demo network: real nodes, real signed + mined transfers,
 * and a scripted fork → reorganization.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDemoNetwork } from '../src/demo-network.js';
import { ExplorerApi } from '../src/api.js';

const TIMEOUT = { timeout: 20_000 };

async function start(t, options) {
  const demo = await startDemoNetwork(options);
  t.after(() => demo.stop());
  return demo;
}

const tips = (demo) => new Set(demo.nodes.map((n) => n.tipHash));

test('seeds three connected nodes with the same real chain', TIMEOUT, async (t) => {
  const demo = await start(t);
  assert.deepEqual(demo.nodes.map((n) => n.id), ['alice', 'bob', 'charlie']);
  assert.equal(tips(demo).size, 1);
  for (const node of demo.nodes) {
    assert.equal(node.height, 4);
    assert.equal(node.ledger.isValid(), true);
    assert.equal(node.peerIds.length, 2);
  }
  // Same genesis allocation everywhere; total supply conserved.
  assert.equal(new Set(demo.nodes.map((n) => n.ledger.genesisHash)).size, 1);
  const balances = demo.nodes[0].ledger.getAccounts().map((a) => a.balance);
  assert.equal(balances.reduce((s, b) => s + b, 0), 300);
});

test('each node keeps its own ledger object', TIMEOUT, async (t) => {
  const demo = await start(t);
  const [a, b, c] = demo.nodes;
  assert.notEqual(a.ledger, b.ledger);
  assert.notEqual(b.ledger, c.ledger);
  assert.notEqual(a.ledger.chain[1], b.ledger.chain[1]);
});

test('exposes only public labels, never wallets', TIMEOUT, async (t) => {
  const demo = await start(t);
  assert.deepEqual(Object.values(demo.addressLabels).sort(), ['Alice', 'Bob', 'Charlie']);
  assert.equal(demo.wallets, undefined);
  assert.doesNotMatch(JSON.stringify(Object.keys(demo)), /wallet/i);
});

test('mineNext propagates a new block to every node', TIMEOUT, async (t) => {
  const demo = await start(t);
  await demo.mineNext();
  await demo.mineNext();
  assert.equal(tips(demo).size, 1);
  assert.ok(demo.nodes.every((n) => n.height === 6));
});

test('fork() creates diverging chains; heal() reorganizes Charlie', TIMEOUT, async (t) => {
  const demo = await start(t);
  const [alice, bob, charlie] = demo.nodes;

  await demo.fork();
  assert.equal(demo.isForked, true);
  assert.equal(alice.tipHash, bob.tipHash);
  assert.notEqual(charlie.tipHash, alice.tipHash);
  assert.equal(alice.height, 6);
  assert.equal(charlie.height, 5);
  await assert.rejects(demo.fork(), /Already forked/);

  const reorgs = [];
  charlie.on('reorg', (r) => reorgs.push(r));
  const results = await demo.heal();
  assert.equal(results.filter((r) => r.adopted).length, 1);
  assert.equal(reorgs.length, 1);
  assert.equal(reorgs[0].orphanedTransactions.length, 1); // Charlie → Bob 7 is no longer confirmed
  assert.equal(tips(demo).size, 1);
  assert.equal(demo.isForked, false);
});

test('the API shows the fork from each node\'s own point of view', TIMEOUT, async (t) => {
  const demo = await start(t);
  const api = new ExplorerApi({ nodes: demo.nodes, addressLabels: demo.addressLabels });
  t.after(() => api.stop());
  await api.start();
  const get = async (p) => (await fetch(`${api.url}${p}`)).json();

  await demo.fork();
  const forkView = await get('/api/network');
  assert.equal(forkView.inSync, false);
  assert.equal(forkView.commonHeight, 4);
  const charlieTip = (await get('/api/nodes/charlie')).tipHash;
  assert.notEqual(charlieTip, (await get('/api/nodes/alice')).tipHash);
  const charlieTxs = (await get('/api/nodes/charlie/transactions')).transactions;
  assert.equal(charlieTxs[0].recipientLabel, 'Bob');
  assert.equal(charlieTxs[0].amount, 7);

  await demo.heal();
  const healed = await get('/api/network');
  assert.equal(healed.inSync, true);
  assert.equal(healed.commonHeight, 6);
  const after = (await get('/api/nodes/charlie/transactions')).transactions;
  assert.ok(!after.some((x) => x.amount === 7 && x.senderLabel === 'Charlie'));
});

// ---------- Pending transactions (Milestone 8) ----------

test('sendPending submits without mining and the tx reaches every node', TIMEOUT, async (t) => {
  const demo = await start(t);
  const before = demo.nodes.map((n) => n.height);
  const result = await demo.sendPending('Alice', 'Bob', 1);
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.reached, ['alice', 'bob', 'charlie']);
  assert.deepEqual(demo.nodes.map((n) => n.height), before); // nothing mined
});

test('consecutive pending transfers use consecutive nonces', TIMEOUT, async (t) => {
  const demo = await start(t);
  await demo.sendPending('Alice', 'Bob', 1);
  await demo.sendPending('Alice', 'Bob', 1);
  const nonces = demo.nodes[2].getPendingTransactions().map((e) => e.tx.nonce);
  assert.equal(nonces.length, 2);
  assert.equal(nonces[1], nonces[0] + 1);
});

test('mineSelected mines the selected node\'s pending txs and clears every mempool', TIMEOUT, async (t) => {
  const demo = await start(t);
  await demo.sendPending('Alice', 'Bob', 2);
  await demo.sendPending('Alice', 'Bob', 3);
  const mined = await demo.mineSelected('bob');
  assert.equal(mined.mode, 'mempool');
  assert.equal(mined.txCount, 2);
  for (const node of demo.nodes) {
    assert.equal(node.mempool.size, 0);
    assert.equal(node.tipHash, demo.nodes[0].tipHash);
  }
});

test('mineSelected falls back to the old rotation when nothing is pending', TIMEOUT, async (t) => {
  const demo = await start(t);
  const mined = await demo.mineSelected('charlie');
  assert.equal(mined.mode, 'fallback');
  assert.ok(demo.nodes.every((n) => n.height === 5));
});

test('partition → pending tx misses Charlie → reconnect delivers it; no chain sync', TIMEOUT, async (t) => {
  const demo = await start(t);
  const [alice, bob, charlie] = demo.nodes;
  await demo.partition();
  assert.equal(demo.isCharlieOnline, false);
  const sent = await demo.sendPending('Alice', 'Bob', 1);
  assert.deepEqual(sent.reached, ['alice', 'bob']);
  await demo.mineSelected('bob'); // alice + bob move ahead; charlie doesn't know
  assert.equal(charlie.height, 4);

  // Depends on the block Charlie missed (Alice's next nonce moved on there)...
  const dependent = await demo.sendPending('Alice', 'Charlie', 1);
  // ...versus a tx that is valid on Charlie's (older) chain too.
  const independent = await demo.sendPending('Bob', 'Charlie', 1);

  const pulled = await demo.reconnect();
  assert.equal(demo.isCharlieOnline, true);
  assert.equal(charlie.height, 4); // chain NOT synced by reconnecting
  assert.notEqual(charlie.tipHash, alice.tipHash);
  assert.ok(charlie.mempool.has(independent.id)); // delivered on reconnect
  assert.ok(!charlie.mempool.has(dependent.id)); // rejected: on HIS chain it skips a nonce
  assert.ok(pulled.every((p) => p.rejected >= 1));

  await demo.heal(); // explicit sync: chain first, then mempool again
  assert.equal(charlie.tipHash, alice.tipHash);
  assert.equal(bob.tipHash, alice.tipHash);
  assert.ok(charlie.mempool.has(dependent.id)); // valid now that he has the block
  assert.ok(charlie.mempool.has(independent.id));
});

test('fork + pending: the orphaned tx is recovered into Charlie\'s mempool after heal', TIMEOUT, async (t) => {
  const demo = await start(t);
  const charlie = demo.nodes[2];
  await demo.fork();
  await demo.heal();
  const pending = charlie.getPendingTransactions();
  assert.equal(pending.length, 1); // Charlie → Bob 7, still valid on the winning chain
  assert.equal(pending[0].source, 'orphan-recovery');
});

// ---------- Contracts (Milestone 9) ----------

test('escrow life cycle: deploy → fund → premature claim rejected → claim after unlock', TIMEOUT, async (t) => {
  const demo = await start(t);
  const [alice, bob, charlie] = demo.nodes;
  const deployed = await demo.deployEscrow({ amount: 20, deposit: 10, unlockIn: 3, expiresIn: 8 });
  assert.equal(deployed.status, 'accepted');
  assert.deepEqual(deployed.reached, ['alice', 'bob', 'charlie']);
  await demo.mineSelected('alice');
  assert.equal(charlie.ledger.getContract(deployed.contractId).status, 'funding');

  assert.match((await demo.claimEscrow()).reason, /Insufficient funding: 10 of 20/);
  assert.equal((await demo.fundEscrow()).status, 'accepted');
  await demo.mineSelected('bob');
  const early = await demo.claimEscrow();
  assert.equal(early.status, 'rejected');
  assert.match(early.reason, /Too early/);

  while (bob.height + 1 < deployed.unlockHeight) await demo.mineSelected('charlie'); // fallback blocks
  const claim = await demo.claimEscrow();
  assert.equal(claim.status, 'accepted');
  await demo.mineSelected('alice');
  for (const node of demo.nodes) {
    assert.equal(node.ledger.getContract(deployed.contractId).status, 'claimed');
  }
  assert.match((await demo.claimEscrow()).reason, /already claimed/);
  assert.equal(new Set(demo.nodes.map((n) => JSON.stringify(n.ledger.getContracts()))).size, 1);
});

test('refund before expiry is rejected; after expiry Alice gets her coins back', TIMEOUT, async (t) => {
  const demo = await start(t);
  const alice = demo.nodes[0];
  const deployed = await demo.deployEscrow({ amount: 10, deposit: 10, unlockIn: 1, expiresIn: 3 });
  await demo.mineSelected('alice');
  assert.match((await demo.refundEscrow()).reason, /Too early to refund/);
  while (alice.height + 1 < deployed.expiryHeight) await demo.mineSelected('bob');
  assert.equal((await demo.refundEscrow()).status, 'accepted');
  await demo.mineSelected('alice');
  assert.equal(alice.ledger.getContract(deployed.contractId).status, 'refunded');
});

test('contract reorg scenario: Charlie\'s claim rolls back and returns to pending', TIMEOUT, async (t) => {
  const demo = await start(t);
  const r = await demo.contractReorgScenario();
  assert.equal(r.charlieBefore, 'claimed');
  assert.equal(r.majorityView, 'funded');
  assert.equal(r.charlieAfter, 'funded');
  assert.equal(r.claimPendingAgain, true);
  assert.equal(new Set(demo.nodes.map((n) => n.tipHash)).size, 1);
  await demo.mineSelected('bob');
  for (const node of demo.nodes) assert.equal(node.ledger.getContract(r.contractId).status, 'claimed');
});

test('contract actions without a confirmed escrow explain what to do', TIMEOUT, async (t) => {
  const demo = await start(t);
  await assert.rejects(demo.claimEscrow(), /No escrow yet/);
  await demo.deployEscrow();
  await assert.rejects(demo.fundEscrow(), /isn't confirmed on alice yet/);
});
