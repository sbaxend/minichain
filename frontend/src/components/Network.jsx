import { bestNode, formatWork, hashPrefix, relationToBest } from '../format.js';
import { Badge, Hash, Loadable } from './ui.jsx';

const RELATION = {
  synced: { tone: 'ok', text: 'In sync' },
  behind: { tone: 'warn', text: 'Behind' },
  diverged: { tone: 'danger', text: 'Forked' },
};

/** Node picker shown on every tab. Flags nodes whose chain differs from the best one. */
export function NodeSwitcher({ nodes, selectedId, onSelect }) {
  const best = bestNode(nodes);
  return (
    <div className="node-switcher" role="group" aria-label="Choose a node">
      {nodes.map((node) => {
        const relation = relationToBest(node, best);
        return (
          <button
            type="button"
            key={node.id}
            className={`node-chip relation-${relation}${node.id === selectedId ? ' active' : ''}`}
            aria-pressed={node.id === selectedId}
            onClick={() => onSelect(node.id)}
          >
            <span className="node-name">{node.id}</span>
            <span className="node-meta">#{node.height} · {hashPrefix(node.tipHash)}</span>
            {node.pendingCount > 0 && <span className="pending-count">{node.pendingCount} pending</span>}
            {relation !== 'synced' && <Badge tone={RELATION[relation].tone}>{RELATION[relation].text}</Badge>}
          </button>
        );
      })}
    </div>
  );
}

export function NetworkView({ network, selectedId, onSelect }) {
  return (
    <Loadable state={network} label="network">
      {(data) => <NetworkContent data={data} selectedId={selectedId} onSelect={onSelect} />}
    </Loadable>
  );
}

export function NetworkContent({ data, selectedId, onSelect }) {
  const best = bestNode(data.nodes);
  return (
    <>
      {data.inSync ? (
        <div className="banner banner-ok" role="status">
          <strong>All {data.nodes.length} nodes agree.</strong> Same tip at height {data.bestHeight}.
        </div>
      ) : (
        <div className="banner banner-warn" role="status">
          <strong>Fork: {data.distinctTips} different chain tips.</strong> Nodes agree up to height{' '}
          {data.commonHeight}, then their histories differ. When they sync, each adopts the valid chain
          with the most accumulated work.
        </div>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2>Nodes</h2>
          <span className="muted">each node keeps its own independent ledger</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Node</th>
                <th className="num">Height</th>
                <th>Tip</th>
                <th className="num">Work</th>
                <th className="num">Pending</th>
                <th>Peers</th>
                <th>Valid</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.nodes.map((node) => {
                const relation = relationToBest(node, best);
                return (
                  <tr
                    key={node.id}
                    className={`clickable${node.id === selectedId ? ' selected' : ''}`}
                    onClick={() => onSelect(node.id)}
                    onKeyDown={(e) => e.key === 'Enter' && onSelect(node.id)}
                    tabIndex={0}
                  >
                    <td><strong>{node.id}</strong></td>
                    <td className={`num${node.height !== data.bestHeight ? ' differs' : ''}`}>{node.height}</td>
                    <td className={node.tipHash !== best.tipHash ? 'differs' : ''}><Hash value={node.tipHash} zeros /></td>
                    <td className="num">{formatWork(node.work)}</td>
                    <td className="num">{node.pendingCount ?? 0}</td>
                    <td>{node.peers.length ? node.peers.join(', ') : <span className="muted">none</span>}</td>
                    <td>{node.valid ? <Badge tone="ok">✓</Badge> : <Badge tone="danger">✗</Badge>}</td>
                    <td><Badge tone={RELATION[relation].tone}>{RELATION[relation].text}</Badge></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Chain comparison</h2>
          <span className="muted">recent blocks by height</span>
        </div>
        <ChainComparison nodes={data.nodes} best={best} bestHeight={data.bestHeight} />
        <div className="legend">
          <span><i className="cell-agree" /> all nodes agree</span>
          <span><i className="cell-best" /> on the most-work chain</span>
          <span><i className="cell-fork" /> different branch</span>
          <span><i className="cell-missing" /> no block at this height</span>
        </div>
      </section>
    </>
  );
}

/** Grid: one row per node, one column per height. Colours show where chains differ. */
export function ChainComparison({ nodes, best, bestHeight }) {
  const first = Math.max(0, bestHeight - 7);
  const heights = Array.from({ length: bestHeight - first + 1 }, (_, i) => first + i);
  const hashAt = (node, height) => node.recent.find((b) => b.height === height)?.hash ?? null;

  return (
    <div className="table-wrap">
      <table className="chain-grid">
        <thead>
          <tr>
            <th>Node</th>
            {heights.map((h) => <th key={h} className="num">#{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {nodes.map((node) => (
            <tr key={node.id}>
              <th scope="row">{node.id}</th>
              {heights.map((h) => {
                const hash = hashAt(node, h);
                const column = nodes.map((n) => hashAt(n, h));
                const allAgree = column.every((x) => x && x === column[0]);
                let kind = 'cell-agree';
                if (!hash) kind = 'cell-missing';
                else if (!allAgree) kind = hash === hashAt(best, h) ? 'cell-best' : 'cell-fork';
                return (
                  <td key={h} className={kind} title={hash ?? 'no block'}>
                    {hash ? hashPrefix(hash) : '—'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
