import { useState } from 'react';
import { usePolling } from '../hooks/usePolling.js';
import { formatCoins } from '../format.js';
import { Address, Badge, Hash, Loadable, StateMessage } from './ui.jsx';
import { sourceLabel } from './Transactions.jsx';

/**
 * Mempool tab: every node's OWN view of each recent transaction, side by side.
 * A transaction moves  —  →  Pending  →  Confirmed  in each column as gossip
 * reaches that node and as it adopts a block containing it.
 */
export function MempoolView({ selectedId, onSelect }) {
  const state = usePolling('/api/mempool');
  return (
    <Loadable state={state} label="network mempool">
      {(data) => <MempoolContent data={data} selectedId={selectedId} onSelect={onSelect} />}
    </Loadable>
  );
}

export function MempoolContent({ data, selectedId, onSelect }) {
  const [pendingOnly, setPendingOnly] = useState(false);
  const rows = pendingOnly ? data.transactions.filter((t) => t.pendingOn > 0) : data.transactions;
  const nodeIds = data.nodes.map((n) => n.id);

  return (
    <>
      {data.inSync ? (
        <div className="banner banner-ok" role="status">
          <strong>All mempools match.</strong> Every node holds the same {data.nodes[0]?.pendingCount ?? 0} pending
          transaction(s).
        </div>
      ) : (
        <div className="banner banner-warn" role="status">
          <strong>Mempools differ.</strong> Gossip hasn't reached everyone yet, a node is partitioned, or a node
          rejected a transaction that doesn't fit its own chain (for example, a skipped nonce).
        </div>
      )}

      <section className="mempool-nodes" aria-label="Mempool size per node">
        {data.nodes.map((node) => (
          <button
            type="button"
            key={node.id}
            className={`mempool-node${node.id === selectedId ? ' active' : ''}`}
            aria-pressed={node.id === selectedId}
            onClick={() => onSelect(node.id)}
          >
            <span className="node-name">{node.id}</span>
            <span className="mempool-count">{node.pendingCount}</span>
            <span className="muted small">pending</span>
            {node.missing > 0 && <Badge tone="warn">missing {node.missing}</Badge>}
          </button>
        ))}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Transaction propagation</h2>
          <label className="toggle">
            <input type="checkbox" checked={pendingOnly} onChange={(e) => setPendingOnly(e.target.checked)} />
            Pending only
          </label>
        </div>
        <p className="muted small">
          Each column is that node's own view — nodes don't share a mempool, they each check and store
          transactions themselves. Recently confirmed transactions stay listed so you can watch them land.
        </p>
        <PropagationTable rows={rows} nodeIds={nodeIds} />
        <div className="legend">
          <span><i className="cell-unknown" /> not known to this node</span>
          <span><i className="cell-pending" /> pending in its mempool</span>
          <span><i className="cell-confirmed" /> confirmed in its chain</span>
        </div>
      </section>
    </>
  );
}

export function PropagationTable({ rows, nodeIds }) {
  if (!rows.length) {
    return (
      <StateMessage kind="empty" title="No transactions to show">
        Nothing is pending on any node. Press <code>t</code> in the explorer terminal to submit one.
      </StateMessage>
    );
  }
  return (
    <div className="table-wrap">
      <table className="propagation">
        <thead>
          <tr>
            <th>Tx ID</th>
            <th>From</th>
            <th>To</th>
            <th className="num">Amount</th>
            <th className="num">Nonce</th>
            {nodeIds.map((id) => <th key={id} className="node-col">{id}</th>)}
            <th>Overall</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((tx) => (
            <tr key={tx.id}>
              <td><Hash value={tx.id} /></td>
              <td><Address address={tx.sender} label={tx.senderLabel} /></td>
              <td><Address address={tx.recipient} label={tx.recipientLabel} /></td>
              <td className="num amount">{formatCoins(tx.amount)}</td>
              <td className="num">{tx.nonce}</td>
              {nodeIds.map((id) => <StatusCell key={id} view={tx.statusByNode[id]} />)}
              <td><Overall tx={tx} total={nodeIds.length} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusCell({ view }) {
  if (view?.status === 'confirmed') {
    return <td className="cell-confirmed" title="Confirmed in this node's chain">Confirmed #{view.blockHeight}</td>;
  }
  if (view?.status === 'pending') {
    return <td className="cell-pending" title={sourceLabel(view.source)}>Pending</td>;
  }
  return <td className="cell-unknown" title="This node has not seen it">—</td>;
}

function Overall({ tx, total }) {
  if (tx.confirmedOn === total) return <Badge tone="ok">Confirmed everywhere</Badge>;
  if (tx.confirmedOn > 0) return <Badge tone="warn">Confirmed on {tx.confirmedOn}/{total}</Badge>;
  return <Badge tone="info">Pending on {tx.pendingOn}/{total}</Badge>;
}
