/**
 * Demo: the MiniChain Explorer.
 *
 * Starts three real nodes (alice, bob, charlie), seeds them with signed and
 * mined transfers of FICTIONAL coins, and serves a read-only API + the React
 * dashboard on http://127.0.0.1:5180.
 *
 *   npm run explorer                  build the frontend, then start everything
 *   npm run demo:explorer             start without rebuilding
 *   npm run demo:explorer -- --fork   start in a forked state
 *   npm run demo:explorer -- --check  start, self-test over HTTP, then exit
 *
 * The browser can only LOOK. To change the network, use this terminal:
 *   t = new pending transfer (Alice → Bob 1), submitted to alice's mempool
 *   m = mine a block from the SELECTED node's mempool (or a fallback transfer)
 *   n = select the next node (alice → bob → charlie)
 *   f = fork: partition Charlie, both sides mine competing blocks
 *   p = partition only: disconnect Charlie, mine nothing
 *   r = reconnect Charlie WITHOUT syncing chains (pending txs are exchanged)
 *   s = sync/heal: reconnect if needed, then adopt the most-work chain
 *   q or Ctrl+C = quit
 *
 * Timelock-escrow contract (Alice locks coins for Bob; all calls go to the mempool — press m to mine):
 *   d = deploy an escrow (20 coins, 10 deposited now; unlocks in 3 blocks, expires in 8)
 *   a = add funds (Alice tops it up to 20)
 *   c = Bob claims (rejected until the unlock height and until fully funded)
 *   e = Alice refunds (only from the expiry height, if Bob never claimed)
 *   x = scripted contract-reorg scenario: a claim confirmed only on Charlie's
 *       branch is rolled back when he adopts the longer chain
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDemoNetwork } from '../src/demo-network.js';
import { ExplorerApi } from '../src/api.js';

const DEFAULT_PORT = 5180;
const here = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.join(here, '..', 'frontend', 'dist');

// ---------- Arguments ----------

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const portArg = args.indexOf('--port');
const port = portArg === -1 ? DEFAULT_PORT : Number(args[portArg + 1]);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('Usage: node examples/07-explorer.js [--port N] [--fork] [--check]');
  process.exit(1);
}

const log = (text) => console.log(`  ${text}`);
const short = (hash) => `${hash.slice(0, 10)}…`;
const txShort = (id) => (id ? `${id.slice(0, 8)}` : '????????');

// ---------- Start ----------

console.log('\n  Starting MiniChain explorer demo (fictional coins, localhost only)...');
const demo = await startDemoNetwork();
const api = new ExplorerApi({ nodes: demo.nodes, addressLabels: demo.addressLabels, staticDir });
const nameOf = (address) => demo.addressLabels[address] ?? `${address.slice(0, 8)}…`;
const contractShort = (id) => `${id.slice(0, 10)}…`;
const describeTx = (tx) => {
  const op = tx.contract?.op;
  if (!op) return `${nameOf(tx.sender)} → ${nameOf(tx.recipient)} ${tx.amount} (tx nonce ${tx.nonce})`;
  const verb = { deploy: 'deploys escrow', fund: 'funds escrow', claim: 'claims escrow', refund: 'refunds escrow' }[op];
  return `${nameOf(tx.sender)} ${verb} ${contractShort(tx.recipient)} (${tx.amount} coins, tx nonce ${tx.nonce})`;
};

/** One line per node: that node's OWN view of the current escrow. */
function printContract() {
  const id = demo.currentContract;
  if (!id) return;
  for (const node of demo.nodes) {
    const c = node.ledger.getContract(id);
    log(c
      ? `${node.id.padEnd(8)} escrow ${contractShort(id)} ${c.status.padEnd(8)} ${c.balance}/${c.amount} coins · unlock #${c.unlockHeight} · expiry #${c.expiryHeight} · next block #${node.height + 1}`
      : `${node.id.padEnd(8)} escrow ${contractShort(id)} (not in this node's chain)`);
  }
}

let stopping = false;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  console.log('\n  Shutting down: closing API and nodes...');
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  await api.stop();
  await demo.stop();
  console.log('  Stopped cleanly.\n');
  process.exitCode = code;
}

try {
  await api.start(port);
} catch (err) {
  console.error(`\n  Could not start the API on port ${port}: ${err.message}`);
  console.error('  Is another explorer already running? Try: npm run demo:explorer -- --port 5181\n');
  await demo.stop();
  process.exit(1);
}

if (flag('--fork')) {
  await demo.fork();
  log('Started in a FORKED state: charlie is partitioned with his own block.');
}

function printNetwork() {
  for (const node of demo.nodes) {
    log(
      `${node.id.padEnd(8)} height ${String(node.height).padStart(3)}  tip ${short(node.tipHash)}  ` +
        `pending ${String(node.mempool.size).padStart(2)}  peers: ${node.peerIds.join(', ') || '(none)'}`
    );
  }
}

console.log(`
  ┌──────────────────────────────────────────────────────────────┐
  │  MiniChain Explorer:  ${api.url.padEnd(39)}│
  └──────────────────────────────────────────────────────────────┘`);
printNetwork();

// ---------- --check: self-test and exit ----------

if (flag('--check')) {
  const get = async (p) => {
    const res = await fetch(`${api.url}${p}`);
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
  };
  const checks = [];
  const check = (label, ok) => {
    checks.push(ok);
    log(`${ok ? '✅' : '❌'} ${label}`);
  };
  console.log('\n  Self-check:');
  check('GET /api/health', (await get('/api/health')).status === 200);
  check('GET /api/nodes/alice is valid', (await get('/api/nodes/alice')).body.validation?.valid === true);
  check('GET /api/nodes/alice/transactions has confirmed transfers', (await get('/api/nodes/alice/transactions')).body.total >= 5);
  const index = await get('/');
  check(`GET / serves the frontend (${index.status === 200 ? 'built' : 'NOT built — run npm run explorer:build'})`, index.status === 200);

  const sent = await demo.sendPending('Alice', 'Bob', 1);
  const pendingRow = (await get('/api/mempool')).body.transactions.find((x) => x.id === sent.id);
  check('pending tx reached all 3 mempools', pendingRow?.pendingOn === 3);
  await demo.mineSelected('bob');
  const confirmedRow = (await get('/api/mempool')).body.transactions.find((x) => x.id === sent.id);
  check('after mining, it is confirmed on all 3 nodes', confirmedRow?.confirmedOn === 3);

  // Contracts: deploy → premature claim rejected → claim after unlock → reorg rollback.
  const deployed = await demo.deployEscrow({ amount: 10, deposit: 10, unlockIn: 2, expiresIn: 9 });
  await demo.mineSelected('alice');
  check('escrow deployed and visible via /api/nodes/bob/contracts',
    (await get('/api/nodes/bob/contracts')).body.contracts.some((c) => c.id === deployed.contractId && c.status === 'funded'));
  const early = await demo.claimEscrow();
  check(`premature claim rejected (${early.reason})`, early.status === 'rejected' && /Too early/.test(early.reason));
  while (demo.nodes[1].height + 1 < deployed.unlockHeight) await demo.mineSelected('charlie');
  const claimed = await demo.claimEscrow();
  await demo.mineSelected('bob');
  const detail = (await get(`/api/nodes/charlie/contracts/${deployed.contractId}`)).body;
  check('claim after unlock confirmed on every node', claimed.status === 'accepted' && detail.status === 'claimed');
  const scenario = await demo.contractReorgScenario();
  check(`reorg rolls Charlie's escrow back: ${scenario.charlieBefore} → ${scenario.charlieAfter}`,
    scenario.charlieBefore === 'claimed' && scenario.charlieAfter === 'funded' && scenario.claimPendingAgain);

  if (!demo.isForked) await demo.fork();
  check('fork visible in /api/network', (await get('/api/network')).body.inSync === false);
  await demo.heal();
  check('after sync, all nodes agree', (await get('/api/network')).body.inSync === true);
  await shutdown(checks.every(Boolean) ? 0 : 1);
} else {
  // ---------- Live event log ----------

  for (const node of demo.nodes) {
    const tag = `[${node.id}]`.padEnd(10);
    node.on('txAccepted', ({ id, tx, source }) => {
      log(source
        ? `${tag} ⇠ pending   ${txShort(id)}  ${describeTx(tx)}  (relayed from ${source})`
        : `${tag} ✚ submitted ${txShort(id)}  ${describeTx(tx)}`);
    });
    node.on('txRejected', ({ id, reason, source }) => {
      log(`${tag} ✖ rejected  ${txShort(id)}  ${reason}${source ? ` (from ${source})` : ''}`);
    });
    node.on('mempoolChanged', ({ confirmed, recovered, dropped, skippedRecovery }) => {
      if (confirmed.length) log(`${tag} ✔ confirmed ${confirmed.length} pending tx(s) — removed from mempool`);
      for (const id of recovered) log(`${tag} ↺ recovered ${txShort(id)}  from an abandoned block (back to pending)`);
      for (const d of dropped) {
        log(`${tag} ✖ dropped   ${txShort(d.id)}  ${d.wasRecovery ? '(orphan) ' : ''}${d.reason}`);
      }
      if (skippedRecovery) log(`${tag} … ${skippedRecovery} orphaned tx(s) not re-checked (recovery limit)`);
    });
    node.on('reorg', (r) => {
      log(`${tag} ↺ REORG     abandoned ${r.removedBlocks.length} block(s), adopted ${r.addedBlocks.length}; ` +
        `${r.orphanedTransactions.length} tx(s) orphaned`);
    });
  }

  // ---------- Interactive controls ----------

  const nodeIds = demo.nodes.map((n) => n.id);
  let selected = 0;

  console.log(`
  Open the URL above in your browser. It refreshes every 2 seconds.

  Controls (this terminal):
    [t] pending Alice → Bob transfer   [m] mine selected node's mempool   [n] next node
    [f] fork (competing blocks)        [p] partition Charlie only
    [r] reconnect Charlie (no sync)    [s] sync/heal                      [q] quit
  Escrow contract (Alice → Bob, then [m] to mine each step):
    [d] deploy   [a] add funds   [c] Bob claims   [e] Alice refunds   [x] scripted contract reorg

  Selected node: ${nodeIds[selected]}
`);

  let busy = false;
  async function run(label, action) {
    if (busy) return log('(busy — wait for the previous action to finish)');
    busy = true;
    try {
      log(`→ ${label}`);
      const result = await action();
      if (result) log(result);
      printNetwork();
      printContract();
    } catch (err) {
      log(`⚠️  ${err.message}`);
    } finally {
      busy = false;
    }
  }

  const actions = {
    t: () => run('Signing Alice → Bob 1 and submitting it to alice\'s mempool (not mined)...', async () => {
      const r = await demo.sendPending('Alice', 'Bob', 1);
      return r.status === 'accepted'
        ? `PENDING on: ${r.reached.join(', ')}. Press [m] to mine it.`
        : `Not accepted (${r.status}): ${r.reason ?? ''}`;
    }),
    m: () => run(`Mining a block on ${nodeIds[selected]}...`, async () => {
      const r = await demo.mineSelected(nodeIds[selected]);
      if (r.mode === 'mempool') return `${r.miner} mined block ${r.height} with ${r.txCount} pending transaction(s).`;
      const [[from, to, amount]] = r.transfers;
      return `${nodeIds[selected]} had nothing pending → fallback: ${r.miner} mined block ${r.height}: ${from} → ${to} ${amount} coins`;
    }),
    n: () => {
      selected = (selected + 1) % nodeIds.length;
      log(`Selected node: ${nodeIds[selected]} (press [m] to mine its pending transactions)`);
    },
    f: () => run('Forking: Charlie goes offline; both sides keep mining...', async () => {
      await demo.fork();
      return 'FORK: alice/bob have 2 new blocks, charlie has 1 different block. Look at the Network tab.';
    }),
    p: () => run('Partitioning: disconnecting Charlie (nothing mined)...', async () => {
      await demo.partition();
      return 'Charlie is offline. Press [t] — the pending tx will reach alice and bob only. Then [r].';
    }),
    r: () => run('Reconnecting Charlie WITHOUT syncing chains...', async () => {
      const pulled = await demo.reconnect();
      const summary = pulled.map((p) => `${p.peerId}: +${p.accepted} new, ${p.known} known, ${p.rejected} rejected`).join('; ');
      return `Charlie exchanged pending txs (${summary}). Chains NOT synced — any fork is still visible. [s] to heal.`;
    }),
    d: () => run('Alice deploys a timelock escrow for Bob (pending until mined)...', async () => {
      const r = await demo.deployEscrow();
      return r.status === 'accepted'
        ? `Escrow ${contractShort(r.contractId)}: ${r.deposit}/${r.amount} coins deposited, claimable from block #${r.unlockHeight}, ` +
          `refundable from #${r.expiryHeight}. PENDING on ${r.reached.join(', ')} — press [m] to mine it.`
        : `Deploy rejected: ${r.reason}`;
    }),
    a: () => run('Alice adds funds to the escrow...', async () => {
      const r = await demo.fundEscrow();
      return r.status === 'accepted' ? `Fund of ${r.amount} is PENDING — press [m] to mine it.` : `Fund rejected: ${r.reason}`;
    }),
    c: () => run('Bob claims the escrow...', async () => {
      const r = await demo.claimEscrow();
      return r.status === 'accepted'
        ? `Claim of ${r.amount} is PENDING (next block #${r.nextHeight} ≥ unlock #${r.unlockHeight}) — press [m] to mine it.`
        : `Claim REJECTED: ${r.reason}`;
    }),
    e: () => run('Alice asks for a refund...', async () => {
      const r = await demo.refundEscrow();
      return r.status === 'accepted'
        ? `Refund of ${r.amount} is PENDING — press [m] to mine it.`
        : `Refund REJECTED: ${r.reason}`;
    }),
    x: () => run('Scripted contract reorg: claim mined only on Charlie\'s branch, then he adopts the longer chain...', async () => {
      const r = await demo.contractReorgScenario();
      return `Charlie's view of escrow ${contractShort(r.contractId)}: ${r.charlieBefore} on his branch → ${r.charlieAfter} ` +
        `after the reorg (the longer chain never had the claim). The claim is ${r.claimPendingAgain ? 'PENDING again on every node — press [m] to confirm it' : 'not pending'}.`;
    }),
    s: () => run('Reconnecting Charlie (if needed) and syncing...', async () => {
      const results = await demo.heal();
      const adopted = results.find((r) => r.adopted);
      const orphans = adopted?.reorg?.orphanedTransactions.length ?? 0;
      return adopted
        ? `charlie REORGANIZED onto the chain with more work; ${orphans} transaction(s) orphaned.`
        : 'charlie kept his chain.';
    }),
  };

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (key) => {
      if (key === 'q' || key === '\u0003') return shutdown();
      actions[key.toLowerCase()]?.();
    });
  } else {
    log('(No interactive terminal detected: keyboard controls disabled. Ctrl+C to stop.)');
  }
  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());
}
