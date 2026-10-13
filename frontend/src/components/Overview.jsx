import { usePolling } from '../hooks/usePolling.js';
import { formatCoins, formatWork } from '../format.js';
import { Badge, Hash, Loadable, StatCard } from './ui.jsx';
import { BlockList } from './Blocks.jsx';

export function Overview({ nodeId, onOpenBlock }) {
  const state = usePolling(`/api/nodes/${encodeURIComponent(nodeId)}`);
  return (
    <Loadable state={state} label="node summary">
      {(summary) => <OverviewContent summary={summary} onOpenBlock={onOpenBlock} />}
    </Loadable>
  );
}

export function OverviewContent({ summary: s, onOpenBlock }) {
  return (
    <>
      <section className="stat-grid" aria-label="Node statistics">
        <StatCard label="Block height" hint={`blocks after genesis on ${s.id}'s chain`}>
          {s.height}
        </StatCard>
        <StatCard label="Latest block" hint="tip hash (leading zeros = proof-of-work)">
          <Hash value={s.tipHash} zeros />
        </StatCard>
        <StatCard label="Difficulty" hint="leading hex zeros required per block">
          {s.difficulty}
        </StatCard>
        <StatCard label="Accumulated work" hint="expected hashes behind this chain">
          {formatWork(s.work)}
        </StatCard>
        <StatCard label="Validation" hint="full replay from genesis">
          {s.validation.valid
            ? <Badge tone="ok">Valid ✓</Badge>
            : <Badge tone="danger">Invalid at block {s.validation.index}</Badge>}
        </StatCard>
        <StatCard label="Peers" hint={s.peers.length ? s.peers.join(', ') : 'not connected to anyone'}>
          {s.peers.length}
        </StatCard>
        <StatCard
          label="Pending transactions"
          hint={`in ${s.id}'s own mempool${s.mempoolLimits ? ` · limit ${s.mempoolLimits.maxSize}` : ''}`}
        >
          {s.pendingCount ?? 0}
        </StatCard>
        <StatCard label="Contracts" hint="timelock escrows confirmed on this chain">
          {s.contractCount ?? 0}
        </StatCard>
        <StatCard label="Total supply" hint="fictional coins · no real value">
          {formatCoins(s.totalSupply)}
        </StatCard>
        <StatCard label="Genesis" hint={`${s.protocol} · P2P port ${s.p2pPort ?? '—'}`}>
          <Hash value={s.genesisHash} />
        </StatCard>
      </section>

      {!s.validation.valid && (
        <div className="alert" role="alert">Chain invalid: {s.validation.reason}</div>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2>Recent blocks</h2>
          <span className="muted">click a block to inspect it</span>
        </div>
        <BlockList blocks={s.recentBlocks} onSelect={onOpenBlock} />
      </section>
    </>
  );
}
