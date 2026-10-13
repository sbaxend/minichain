import { useState } from 'react';
import { usePolling } from '../hooks/usePolling.js';
import { formatCoins } from '../format.js';
import { Address, Badge, CopyButton, Hash, Loadable, StateMessage } from './ui.jsx';

export const STATUS_TONE = { funding: 'warn', funded: 'info', claimed: 'ok', refunded: 'neutral' };
export const PHASE_TONE = { funding: 'warn', locked: 'neutral', claimable: 'ok', refundable: 'warn', claimed: 'ok', refunded: 'neutral' };
export const KIND_TONE = { transfer: 'neutral', deploy: 'info', fund: 'info', claim: 'ok', refund: 'warn' };

/** Contracts tab: this node's confirmed contracts, and details for the selected one. */
export function ContractsView({ nodeId }) {
  const [selectedId, setSelectedId] = useState(null);
  const list = usePolling(`/api/nodes/${encodeURIComponent(nodeId)}/contracts`);
  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Contracts</h2>
          {list.data && (
            <span className="muted">
              {list.data.count} in {nodeId}'s chain · limit {list.data.limit} · next block #{list.data.nextHeight}
            </span>
          )}
        </div>
        <p className="notice">
          <Badge tone="info">Timelock escrow</Badge> Not code — a fixed template with checked terms. Time is the
          <strong> block height</strong>: Bob may claim from the unlock height until expiry; after expiry only Alice
          may refund.
        </p>
        <Loadable state={list} label="contracts">
          {(data) => <ContractList contracts={data.contracts} selectedId={selectedId} onSelect={setSelectedId} />}
        </Loadable>
      </section>
      <section className="panel" aria-label="Contract details">
        {selectedId
          ? <ContractDetailLoader nodeId={nodeId} contractId={selectedId} />
          : <StateMessage kind="empty" title="No contract selected">Click a contract to see its terms and history.</StateMessage>}
      </section>
    </>
  );
}

export function ContractList({ contracts, selectedId = null, onSelect }) {
  if (!contracts.length) {
    return (
      <StateMessage kind="empty" title="No contracts on this chain">
        In the explorer terminal, press <code>d</code> to deploy an escrow, then <code>m</code> to mine it.
      </StateMessage>
    );
  }
  return (
    <div className="table-wrap">
      <table className="contracts">
        <thead>
          <tr>
            <th>Contract</th>
            <th>Creator</th>
            <th>Beneficiary</th>
            <th className="num">Escrowed</th>
            <th>Status</th>
            <th>Timelock (claim → refund)</th>
            <th className="num">Deployed</th>
          </tr>
        </thead>
        <tbody>
          {contracts.map((c) => (
            <tr
              key={c.id}
              className={`clickable${c.id === selectedId ? ' selected' : ''}`}
              onClick={() => onSelect(c.id)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(c.id))}
              tabIndex={0}
              aria-selected={c.id === selectedId}
            >
              <td><Hash value={c.id} /> <span className="muted small">{c.type}</span></td>
              <td><Address address={c.creator} label={c.creatorLabel} /></td>
              <td><Address address={c.beneficiary} label={c.beneficiaryLabel} /></td>
              <td className="num amount">{formatCoins(c.balance)} / {formatCoins(c.amount)}</td>
              <td>
                <Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge>{' '}
                {c.phase !== c.status && <Badge tone={PHASE_TONE[c.phase]}>{c.phase}</Badge>}
                {c.pendingOps > 0 && <span className="pending-count">{c.pendingOps} pending</span>}
              </td>
              <td><span>#{c.unlockHeight}</span> <span className="muted">→</span> <span>#{c.expiryHeight}</span></td>
              <td className="num">#{c.deployedAt}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ContractDetailLoader({ nodeId, contractId }) {
  const state = usePolling(`/api/nodes/${encodeURIComponent(nodeId)}/contracts/${contractId}`);
  // 404 is meaningful: THIS node's chain doesn't contain the contract (e.g. on another branch).
  if (state.error?.status === 404) {
    return (
      <StateMessage kind="empty" title={`Not in ${nodeId}'s chain`}>
        Contract <Hash value={contractId} /> isn't confirmed on this node. {state.error.message.includes('pending')
          ? 'Its deployment is pending in this node\'s mempool — mine a block to confirm it.'
          : 'This node may be on a different branch, or hasn\'t received the block yet.'}
      </StateMessage>
    );
  }
  return (
    <Loadable state={state} label="contract">
      {(contract) => <ContractDetail contract={contract} />}
    </Loadable>
  );
}

/** Plain-English explanation of what can happen next, at the next block height. */
export function phaseExplanation(c) {
  const until = (h) => Math.max(0, h - c.nextHeight);
  const creator = c.creatorLabel ?? 'The creator';
  const beneficiary = c.beneficiaryLabel ?? 'the beneficiary';
  switch (c.phase) {
    case 'funding':
      return `Waiting for funds: ${c.balance} of ${c.amount} deposited. Only ${creator} can add funds; nobody can claim yet.`;
    case 'locked':
      return `Fully funded and locked. ${beneficiary} can claim from block #${c.unlockHeight} (${until(c.unlockHeight)} more block${until(c.unlockHeight) === 1 ? '' : 's'}).`;
    case 'claimable':
      return `${beneficiary} can claim now — any block before #${c.expiryHeight}.`;
    case 'refundable':
      return `The claim window closed at block #${c.expiryHeight}. Only ${creator} can take the ${c.balance} coins back.`;
    case 'claimed':
      return `Closed: ${beneficiary} claimed it in block #${c.updatedAt}.`;
    case 'refunded':
      return `Closed: ${creator} was refunded in block #${c.updatedAt}.`;
    default:
      return '';
  }
}

export function ContractDetail({ contract: c }) {
  return (
    <article className="contract-detail">
      <header className="detail-head">
        <h2>{c.type}</h2>
        <Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge>
        {c.phase !== c.status && <Badge tone={PHASE_TONE[c.phase]}>{c.phase}</Badge>}
      </header>
      <p className="notice">{phaseExplanation(c)}</p>

      <dl className="fields">
        <dt>Contract ID</dt>
        <dd><Hash value={c.id} full /> <CopyButton value={c.id} /></dd>
        <dt>Creator</dt>
        <dd><Address address={c.creator} label={c.creatorLabel} full /></dd>
        <dt>Beneficiary</dt>
        <dd><Address address={c.beneficiary} label={c.beneficiaryLabel} full /></dd>
        <dt>Escrowed</dt>
        <dd>{formatCoins(c.balance)} of {formatCoins(c.amount)} fictional coins</dd>
        <dt>Timelock</dt>
        <dd>
          deployed #{c.deployedAt} → claimable #{c.unlockHeight} → refundable #{c.expiryHeight}
          <span className="muted"> · next block #{c.nextHeight}</span>
        </dd>
        <TimelockBar contract={c} />
      </dl>

      <h3>Activity ({c.activity.length})</h3>
      <ActivityTable rows={c.activity} />
      <h3>Pending calls ({c.pending.length})</h3>
      {c.pending.length
        ? <ActivityTable rows={c.pending} pending />
        : <p className="muted small">None in this node's mempool.</p>}
    </article>
  );
}

/** A tiny visual of the windows: deployed ... unlock [claim] expiry [refund]. */
function TimelockBar({ contract: c }) {
  // Map block heights onto a 0–100 scale, from deployment to a little past expiry.
  const start = c.deployedAt;
  const end = Math.max(c.expiryHeight + 2, c.nextHeight + 1);
  const x = (h) => Math.min(100, Math.max(0, ((h - start) / (end - start)) * 100));
  const unlock = x(c.unlockHeight);
  const expiry = x(c.expiryHeight);
  const now = Math.min(x(c.nextHeight), 99.2);
  return (
    <>
      <dt>Windows</dt>
      <dd>
        <svg className="timelock" viewBox="0 0 100 10" preserveAspectRatio="none" role="img"
          aria-label={`Claim window blocks ${c.unlockHeight} to ${c.expiryHeight - 1}, refund from ${c.expiryHeight}, next block ${c.nextHeight}`}>
          <rect x="0" y="3" width="100" height="4" className="tl-locked" />
          <rect x={unlock} y="3" width={expiry - unlock} height="4" className="tl-claim" />
          <rect x={expiry} y="3" width={100 - expiry} height="4" className="tl-refund" />
          <rect x={now} y="0" width="0.8" height="10" className="tl-now" />
        </svg>
        <div className="legend">
          <span><i className="tl-locked" /> locked</span>
          <span><i className="tl-claim" /> claim window</span>
          <span><i className="tl-refund" /> refund window</span>
          <span><i className="tl-now" /> next block</span>
        </div>
      </dd>
    </>
  );
}

function ActivityTable({ rows, pending = false }) {
  if (!rows.length) return <p className="muted small">No confirmed activity.</p>;
  return (
    <div className="table-wrap">
      <table className="txs">
        <thead>
          <tr>
            <th>Call</th>
            <th>{pending ? 'Status' : 'Block'}</th>
            <th>From</th>
            <th>To</th>
            <th className="num">Amount</th>
            <th className="num">Tx nonce</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((tx) => (
            <tr key={tx.id}>
              <td><Badge tone={KIND_TONE[tx.kind]}>{tx.kind}</Badge></td>
              <td>{pending ? <Badge tone="info">Pending</Badge> : `#${tx.blockHeight}`}</td>
              <td><Address address={tx.flow.from} label={tx.flow.fromLabel} /></td>
              <td><Address address={tx.flow.to} label={tx.flow.toLabel} /></td>
              <td className="num amount">{formatCoins(tx.amount)}</td>
              <td className="num">{tx.nonce}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
