import { useState } from 'react';
import { usePolling } from '../hooks/usePolling.js';
import { formatCoins, timeAgo } from '../format.js';
import { Address, Badge, Hash, Loadable, StateMessage } from './ui.jsx';
import { KIND_TONE } from './Contracts.jsx';

/** Who the coins move from/to. Contract claims and refunds flow OUT of the contract. */
const flowOf = (tx) => tx.flow ?? { from: tx.sender, fromLabel: tx.senderLabel, to: tx.recipient, toLabel: tx.recipientLabel };

function KindBadge({ kind = 'transfer' }) {
  return <Badge tone={KIND_TONE[kind] ?? 'neutral'}>{kind}</Badge>;
}

const TX_PAGE_SIZE = 100;
const FILTERS = [
  ['confirmed', 'Confirmed'],
  ['pending', 'Pending'],
];

/** Transactions tab: Confirmed (in this node's chain) or Pending (in this node's mempool). */
export function TransactionsView({ nodeId, onOpenBlock }) {
  const [filter, setFilter] = useState('confirmed');
  return (
    <>
      <div className="segmented" role="group" aria-label="Transaction status">
        {FILTERS.map(([key, label]) => (
          <button
            type="button"
            key={key}
            className={key === filter ? 'active' : ''}
            aria-pressed={key === filter}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {filter === 'confirmed'
        ? <ConfirmedTransactions nodeId={nodeId} onOpenBlock={onOpenBlock} onShowPending={() => setFilter('pending')} />
        : <PendingTransactions nodeId={nodeId} />}
    </>
  );
}

function ConfirmedTransactions({ nodeId, onOpenBlock, onShowPending }) {
  const state = usePolling(`/api/nodes/${encodeURIComponent(nodeId)}/transactions?limit=${TX_PAGE_SIZE}`);
  return (
    <Loadable state={state} label="transactions">
      {(data) => (
        <section className="panel">
          <div className="panel-head">
            <h2>Confirmed transactions</h2>
            <span className="muted">
              {data.total} in {nodeId}'s chain{data.total > TX_PAGE_SIZE && ` · newest ${TX_PAGE_SIZE} shown`}
              {data.pending?.count > 0 && (
                <> · <button type="button" className="link" onClick={onShowPending}>{data.pending.count} pending</button></>
              )}
            </span>
          </div>
          <TransactionTable transactions={data.transactions} onOpenBlock={onOpenBlock} />
        </section>
      )}
    </Loadable>
  );
}

export function PendingTransactions({ nodeId }) {
  const state = usePolling(`/api/nodes/${encodeURIComponent(nodeId)}/mempool`);
  return (
    <Loadable state={state} label="pending transactions">
      {(data) => (
        <section className="panel">
          <div className="panel-head">
            <h2>Pending transactions</h2>
            <span className="muted">{data.count} in {nodeId}'s mempool · limit {data.limits.maxSize}</span>
          </div>
          <p className="notice">
            <Badge tone="info">Pending</Badge> Signed and checked by <strong>{nodeId}</strong>, but not in a block
            yet. Every node keeps its own mempool — compare them on the Mempool tab.
          </p>
          <PendingTable transactions={data.transactions} />
        </section>
      )}
    </Loadable>
  );
}

/** Where a pending tx came from, in plain words. */
export function sourceLabel(source) {
  if (source === 'local') return 'submitted here';
  if (source === 'orphan-recovery') return 'recovered after reorg';
  return source ? `relayed by ${source}` : '—';
}

export function PendingTable({ transactions }) {
  if (!transactions.length) {
    return (
      <StateMessage kind="empty" title="No pending transactions">
        This node's mempool is empty. In the explorer terminal, press <code>t</code> to submit one.
      </StateMessage>
    );
  }
  return (
    <div className="table-wrap">
      <table className="txs">
        <thead>
          <tr>
            <th>Status</th>
            <th>Tx ID</th>
            <th>Type</th>
            <th>From</th>
            <th>To</th>
            <th className="num">Amount</th>
            <th className="num">Tx nonce</th>
            <th>Received</th>
            <th>Signature</th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((tx) => (
            <tr key={tx.id}>
              <td><Badge tone="info">Pending</Badge></td>
              <td><Hash value={tx.id} /></td>
              <td><KindBadge kind={tx.kind} /></td>
              <td><Address address={flowOf(tx).from} label={flowOf(tx).fromLabel} /></td>
              <td><Address address={flowOf(tx).to} label={flowOf(tx).toLabel} /></td>
              <td className="num amount">{formatCoins(tx.amount)}</td>
              <td className="num">{tx.nonce}</td>
              <td>
                {sourceLabel(tx.source)}
                {tx.receivedAt && <span className="muted small"> · {timeAgo(tx.receivedAt)}</span>}
              </td>
              <td>{tx.signatureValid ? <Badge tone="ok">Valid ✓</Badge> : <Badge tone="danger">Invalid</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TransactionTable({ transactions, onOpenBlock, showBlock = true }) {
  if (!transactions.length) {
    return <StateMessage kind="empty" title="No confirmed transfers yet" />;
  }
  return (
    <div className="table-wrap">
      <table className="txs">
        <thead>
          <tr>
            <th>Status</th>
            {showBlock && <th>Block</th>}
            <th>Type</th>
            <th>From</th>
            <th>To</th>
            <th className="num">Amount</th>
            <th className="num">Tx nonce</th>
            <th>Signature</th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((tx) => (
            <tr key={tx.id}>
              <td><Badge tone="ok">Confirmed</Badge></td>
              {showBlock && (
                <td>
                  <button type="button" className="link" onClick={() => onOpenBlock?.(tx.blockHash)}>
                    #{tx.blockHeight}
                  </button>
                </td>
              )}
              <td><KindBadge kind={tx.kind} /></td>
              <td><Address address={flowOf(tx).from} label={flowOf(tx).fromLabel} /></td>
              <td><Address address={flowOf(tx).to} label={flowOf(tx).toLabel} /></td>
              <td className="num amount">{formatCoins(tx.amount)}</td>
              <td className="num">{tx.nonce}</td>
              <td>
                {tx.signatureValid
                  ? <Badge tone="ok">Valid ✓</Badge>
                  : <Badge tone="danger">Invalid</Badge>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
