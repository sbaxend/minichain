/**
 * demo-network.js — three real MiniChain nodes for the explorer demo.
 *
 * Starts alice, bob and charlie on 127.0.0.1, connects them, and seeds the
 * chain with REAL signed, mined transfers of fictional coins. Also provides
 * scripted actions to create and heal a fork, so you can watch a
 * reorganization in the explorer, and to send PENDING transactions through
 * the mempool and watch them propagate.
 *
 * Every transfer goes through the miner's mempool first (submit → gossip →
 * mine from mempool), exactly like a user's transaction would.
 *
 * The wallets (and their private keys) stay inside this module. Callers only
 * get the nodes and public address labels — never anything that can sign.
 */
import { Wallet } from './wallet.js';
import { Node } from './node.js';

const NAMES = ['Alice', 'Bob', 'Charlie'];
const STARTING_BALANCE = 100;
const WAIT_MS = 5000;

/**
 * @param {object} [options]
 * @param {number} [options.difficulty=2]
 * @param {boolean} [options.seed=true] - Mine a few starter blocks.
 */
export async function startDemoNetwork({ difficulty = 2, seed = true } = {}) {
  const wallets = Object.fromEntries(NAMES.map((name) => [name, new Wallet()]));
  const allocation = NAMES.map((name) => ({ address: wallets[name].address, amount: STARTING_BALANCE }));
  const nodes = NAMES.map((name) => new Node({ id: name.toLowerCase(), allocation, difficulty }));
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const [alice, bob, charlie] = nodes;
  let forked = false;
  let rotation = 0;

  try {
    await Promise.all(nodes.map((n) => n.start()));
    await alice.connect(bob.port);
    await alice.connect(charlie.port);
    await bob.connect(charlie.port);
  } catch (err) {
    await Promise.all(nodes.map((n) => n.stop()));
    throw err;
  }

  /**
   * Sign a transfer as `from`, using `node`'s view of the next nonce
   * (confirmed nonce + transactions already pending in that node's mempool).
   */
  function signTransfer(node, from, to, amount) {
    const sender = wallets[from];
    const nonce = node.ledger.getNextNonce(sender.address) + node.mempool.pendingCount(sender.address);
    return sender.signTransaction(sender.createTransaction(wallets[to].address, amount, { nonce }));
  }

  /** Wait until every node `start` can reach has the same tip as `start`. */
  function waitForTip(start) {
    return Promise.all(
      reachableFrom(start).map((node) => waitUntil(node, ['chainUpdated'], () => node.tipHash === start.tipHash))
    );
  }

  /** Wait until every reachable node has decided about tx `id` (accepted, known, or rejected). */
  function waitForTx(start, id) {
    return Promise.all(
      reachableFrom(start).map((node) => {
        let decided = node.mempool.has(id);
        const mark = (e) => { if (e.id === id) decided = true; };
        node.on('txRejected', mark);
        return waitUntil(node, ['txAccepted', 'txKnown', 'txRejected'], () => decided || node.mempool.has(id))
          .finally(() => node.off('txRejected', mark));
      })
    );
  }

  /**
   * Submit transfers to `minerId`'s mempool, then mine a block from it, and
   * wait until every node it can reach has the new tip.
   *
   * @param {string} minerId
   * @param {Array<[from: string, to: string, amount: number]>} transfers
   */
  async function mine(minerId, transfers) {
    const miner = byId[minerId];
    for (const [from, to, amount] of transfers) {
      const result = miner.submitTransaction(signTransfer(miner, from, to, amount));
      if (result.status === 'rejected') throw new Error(`${from} → ${to} ${amount} rejected: ${result.reason}`);
    }
    const block = miner.mineFromMempool();
    await waitForTip(miner);
    return { miner: minerId, height: block.index, hash: block.hash, transfers, txCount: block.data.transactions.length };
  }

  /**
   * Sign a transfer and submit it to the SENDER's own node, WITHOUT mining.
   * Waits until every reachable node has checked it.
   *
   * @returns {{ status, id, reason?, reached: string[] }}
   */
  async function sendPending(from = 'Alice', to = 'Bob', amount = 1) {
    const node = byId[from.toLowerCase()];
    const result = node.submitTransaction(signTransfer(node, from, to, amount));
    if (result.status === 'accepted') await waitForTx(node, result.id);
    const reached = nodes.filter((n) => n.mempool.has(result.id)).map((n) => n.id);
    return { ...result, from, to, amount, reached };
  }

  /**
   * Mine a block from `nodeId`'s pending transactions. If it has none, fall
   * back to the previous demo behaviour (mineNext's fixed rotation).
   */
  async function mineSelected(nodeId) {
    const node = byId[nodeId];
    if (!node) throw new Error(`Unknown node: ${nodeId}`);
    const block = node.mineFromMempool();
    if (!block) return { mode: 'fallback', ...(await mineNext()) };
    await waitForTip(node);
    return { mode: 'mempool', miner: nodeId, height: block.index, hash: block.hash, txCount: block.data.transactions.length };
  }

  /** Nodes connected (directly or through others) to `start`, excluding it. */
  function reachableFrom(start) {
    const seen = new Set([start.id]);
    const queue = [start];
    while (queue.length) {
      for (const id of queue.shift().peerIds) {
        if (!seen.has(id) && byId[id]) {
          seen.add(id);
          queue.push(byId[id]);
        }
      }
    }
    return nodes.filter((n) => n !== start && seen.has(n.id));
  }

  /** Mine the next transfer in a fixed, repeatable rotation. */
  async function mineNext() {
    const plan = [
      ['alice', 'Alice', 'Bob', 3],
      ['bob', 'Bob', 'Charlie', 2],
      ['charlie', 'Charlie', 'Alice', 4],
    ];
    for (let attempt = 0; attempt < plan.length; attempt++) {
      const [minerId, from, to, amount] = plan[rotation++ % plan.length];
      if (byId[minerId].getBalance(wallets[from].address) >= amount) {
        return mine(minerId, [[from, to, amount]]);
      }
    }
    throw new Error('Nobody can afford the next demo transfer');
  }

  // ---------- Contracts (timelock escrow: Alice locks coins for Bob) ----------

  let currentContract = null; // the escrow the terminal controls act on

  /** Sign a tx built by `build(wallet, nonce)` as `who`, using `node`'s view of the next nonce. */
  function signWith(node, who, build) {
    const wallet = wallets[who];
    const nonce = node.ledger.getNextNonce(wallet.address) + node.mempool.pendingCount(wallet.address);
    return wallet.signTransaction(build(wallet, nonce));
  }

  /** Submit to `node`'s mempool and wait until every reachable node has decided about it. */
  async function submitVia(node, tx) {
    const result = node.submitTransaction(tx);
    if (result.status === 'accepted') await waitForTx(node, result.id);
    return { ...result, node: node.id, reached: nodes.filter((n) => n.mempool.has(result.id)).map((n) => n.id) };
  }

  function confirmedContract(node, id) {
    if (!id) throw new Error('No escrow yet — press [d] to deploy one');
    const contract = node.ledger.getContract(id);
    if (!contract) throw new Error(`Escrow ${id.slice(0, 10)}… isn't confirmed on ${node.id} yet — press [m] to mine its deployment`);
    return contract;
  }

  /**
   * Alice deploys a timelock escrow for Bob (PENDING until mined). Heights are
   * relative to alice's next block: unlock = next + unlockIn, expiry = next + expiresIn.
   */
  async function deployEscrow({ amount = 20, deposit = 10, unlockIn = 3, expiresIn = 8 } = {}) {
    const next = alice.height + 1;
    const terms = { beneficiary: wallets.Bob.address, amount, deposit, unlockHeight: next + unlockIn, expiryHeight: next + expiresIn };
    const tx = signWith(alice, 'Alice', (w, nonce) => w.createEscrowDeploy(terms, { nonce }));
    const result = await submitVia(alice, tx);
    if (result.status === 'accepted') currentContract = tx.recipient;
    return { ...result, contractId: tx.recipient, ...terms };
  }

  /** Alice tops the escrow up to its full amount. */
  async function fundEscrow(id = currentContract) {
    const contract = confirmedContract(alice, id);
    const amount = Math.max(contract.amount - contract.balance, 1); // 1 if already full → the rules reject it
    const tx = signWith(alice, 'Alice', (w, nonce) => w.createContractCall(id, 'fund', amount, { nonce }));
    return { ...(await submitVia(alice, tx)), amount };
  }

  /** Bob claims the whole balance, submitted to `viaNodeId`'s mempool. */
  async function claimEscrow(id = currentContract, viaNodeId = 'bob') {
    const node = byId[viaNodeId];
    const contract = confirmedContract(node, id);
    const amount = Math.max(contract.balance, 1);
    const tx = signWith(node, 'Bob', (w, nonce) => w.createContractCall(id, 'claim', amount, { nonce }));
    return { ...(await submitVia(node, tx)), amount, nextHeight: node.height + 1, unlockHeight: contract.unlockHeight, expiryHeight: contract.expiryHeight };
  }

  /** Alice takes the coins back (only possible from the expiry height). */
  async function refundEscrow(id = currentContract) {
    const contract = confirmedContract(alice, id);
    const amount = Math.max(contract.balance, 1);
    const tx = signWith(alice, 'Alice', (w, nonce) => w.createContractCall(id, 'refund', amount, { nonce }));
    return { ...(await submitVia(alice, tx)), amount, nextHeight: alice.height + 1, expiryHeight: contract.expiryHeight };
  }

  /**
   * Scripted: show contract state rolling back in a reorg.
   *   1. Alice deploys a funded escrow for Bob; it's mined everywhere.
   *   2. Charlie is partitioned. Bob's claim is mined ONLY on Charlie's branch.
   *   3. Alice + Bob mine a longer branch without the claim.
   *   4. Heal: Charlie adopts the longer chain → his escrow is "funded" again,
   *      and the claim goes back to pending (still valid), ready to be mined.
   */
  async function contractReorgScenario() {
    if (forked || !charlieOnline()) throw new Error('Heal the network first ([s]) — this needs all three nodes connected');
    const deployed = await deployEscrow({ amount: 15, deposit: 15, unlockIn: 1, expiresIn: 30 });
    if (deployed.status !== 'accepted') throw new Error(`Deploy rejected: ${deployed.reason}`);
    await mineSelected('alice'); // next block (unlock height) can now include a claim
    await partition();
    const claim = await claimEscrow(deployed.contractId, 'charlie');
    if (claim.status !== 'accepted') throw new Error(`Claim rejected on charlie: ${claim.reason}`);
    charlie.mineFromMempool();
    const charlieBefore = charlie.ledger.getContract(deployed.contractId).status;
    await mine('alice', [['Alice', 'Bob', 1]]);
    await mine('alice', [['Alice', 'Bob', 1]]);
    const majorityView = alice.ledger.getContract(deployed.contractId).status;
    await heal();
    currentContract = deployed.contractId;
    return {
      contractId: deployed.contractId,
      claimId: claim.id,
      charlieBefore, // 'claimed' — on his own (shorter) branch
      majorityView, // 'funded' — the claim never happened on the longer branch
      charlieAfter: charlie.ledger.getContract(deployed.contractId).status, // 'funded' after the reorg
      claimPendingAgain: nodes.every((n) => n.mempool.has(claim.id)),
    };
  }

  const charlieOnline = () => charlie.peerIds.length > 0;

  /** Disconnect Charlie from everyone — nothing is mined. */
  async function partition() {
    if (!charlieOnline()) throw new Error('Charlie is already disconnected');
    await charlie.disconnectAll();
    await Promise.all([alice, bob].map((n) => waitUntil(n, ['peerDisconnected'], () => !n.peerIds.includes('charlie'))));
  }

  /**
   * Partition Charlie, then let both sides mine: Alice + Bob add TWO blocks,
   * Charlie adds ONE. Result: a fork where Alice/Bob have more work.
   */
  async function fork() {
    if (forked) throw new Error('Already forked — heal() first');
    if (charlieOnline()) await partition();
    forked = true;
    const majority = [await mine('alice', [['Alice', 'Bob', 2]]), await mine('bob', [['Bob', 'Alice', 1]])];
    const minority = await mine('charlie', [['Charlie', 'Bob', 7]]);
    return { majority, minority };
  }

  /**
   * Reconnect Charlie WITHOUT syncing chains: only pending transactions are
   * exchanged (each node checks them itself). A fork, if any, stays visible
   * until heal() — or until someone mines a new block, which peers then adopt.
   *
   * @returns {Array<{ peerId, accepted, known, rejected }>} What Charlie pulled from each peer.
   */
  async function reconnect() {
    if (charlieOnline()) throw new Error('Charlie is already connected');
    const pulled = [];
    for (const peer of [alice, bob]) {
      const synced = waitForEvent(charlie, 'mempoolSynced', (e) => e.peerId === peer.id);
      const reverse = waitForEvent(peer, 'mempoolSynced', (e) => e.peerId === 'charlie');
      await charlie.connect(peer.port);
      pulled.push(await synced);
      await reverse;
    }
    return pulled;
  }

  /** Reconnect Charlie if needed, then sync: he adopts the chain with more work (a reorg). */
  async function heal() {
    if (!forked && charlieOnline() && charlie.tipHash === alice.tipHash) {
      throw new Error('Not forked — fork() first');
    }
    if (!charlieOnline()) await reconnect();
    const results = await charlie.sync();
    forked = false;
    return results;
  }

  if (seed) {
    await mine('alice', [['Alice', 'Bob', 10]]);
    await mine('bob', [['Bob', 'Charlie', 15]]);
    await mine('charlie', [['Charlie', 'Alice', 5]]);
    await mine('alice', [['Alice', 'Charlie', 20], ['Bob', 'Alice', 3]]); // two txs in one block
  }

  return {
    nodes,
    /** Public info only: address → display name. */
    addressLabels: Object.fromEntries(NAMES.map((name) => [wallets[name].address, name])),
    mine,
    mineNext,
    mineSelected,
    sendPending,
    fork,
    partition,
    reconnect,
    heal,
    deployEscrow,
    fundEscrow,
    claimEscrow,
    refundEscrow,
    contractReorgScenario,
    get currentContract() {
      return currentContract;
    },
    get isForked() {
      return forked;
    },
    get isCharlieOnline() {
      return charlieOnline();
    },
    stop: () => Promise.all(nodes.map((n) => n.stop())),
  };
}

/** Resolve with the next `event` payload that matches `filter` (5 s timeout). */
function waitForEvent(emitter, event, filter) {
  return new Promise((resolve, reject) => {
    const handler = (payload) => {
      if (!filter(payload)) return;
      clearTimeout(timer);
      emitter.off(event, handler);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      emitter.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, WAIT_MS);
    emitter.on(event, handler);
  });
}

/** Resolve once `predicate()` is true, re-checking on the given events. */
function waitUntil(emitter, events, predicate) {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) {
        cleanup();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for the network'));
    }, WAIT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      for (const e of events) emitter.off(e, check);
    };
    for (const e of events) emitter.on(e, check);
  });
}
