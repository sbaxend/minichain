import { usePolling } from '../hooks/usePolling.js';
import { formatCoins, formatDateTime, timeAgo } from '../format.js';
import { Address, Badge, CopyButton, Hash, Loadable, StateMessage } from './ui.jsx';
import { TransactionTable } from './Transactions.jsx';

const BLOCK_PAGE_SIZE = 50;

/** Blocks tab: list on the left, details of the selected block on the right. */
export function BlocksView({ nodeId, selectedHash, onSelect }) {
  const id = encodeURIComponent(nodeId);
  const list = usePolling(`/api/nodes/${id}/blocks?limit=${BLOCK_PAGE_SIZE}`);
  return (
    <div className="split">
      <section className="panel">
        <div className="panel-head">
          <h2>Blocks</h2>
          {list.data && (
            <span className="muted">
              {list.data.total} in {nodeId}'s chain
              {list.data.total > BLOCK_PAGE_SIZE && ` · newest ${BLOCK_PAGE_SIZE} shown`}
            </span>
          )}
        </div>
        <Loadable state={list} label="blocks">
          {(data) => <BlockList blocks={data.blocks} selectedHash={selectedHash} onSelect={onSelect} />}
        </Loadable>
      </section>
      <section className="panel detail-panel" aria-label="Block details">
        {selectedHash
          ? <BlockDetailLoader nodeId={nodeId} hash={selectedHash} onSelect={onSelect} />
          : <StateMessage kind="empty" title="No block selected">Click a block to see everything inside it.</StateMessage>}
      </section>
    </div>
  );
}

export function BlockList({ blocks, selectedHash = null, onSelect }) {
  if (!blocks.length) return <StateMessage kind="empty" title="No blocks" />;
  return (
    <div className="table-wrap">
      <table className="blocks">
        <thead>
          <tr>
            <th>Height</th>
            <th>Hash</th>
            <th>Previous</th>
            <th>Time</th>
            <th className="num">Nonce</th>
            <th className="num">Txs</th>
          </tr>
        </thead>
        <tbody>
          {blocks.map((b) => (
            <tr
              key={b.hash}
              className={`clickable${b.hash === selectedHash ? ' selected' : ''}${b.isGenesis ? ' genesis' : ''}`}
              onClick={() => onSelect(b.hash)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(b.hash))}
              tabIndex={0}
              aria-selected={b.hash === selectedHash}
            >
              <td>
                <span className="height">#{b.height}</span>
                {b.isGenesis && <Badge tone="accent">Genesis</Badge>}
              </td>
              <td><Hash value={b.hash} zeros /></td>
              <td>{b.isGenesis ? <span className="muted">—</span> : <Hash value={b.previousHash} zeros />}</td>
              <td title={formatDateTime(b.timestamp)}>{b.isGenesis ? <span className="muted">fixed</span> : timeAgo(b.timestamp)}</td>
              <td className="num">{b.nonce}</td>
              <td className="num">{b.isGenesis ? <span className="muted">alloc.</span> : b.transactionCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BlockDetailLoader({ nodeId, hash, onSelect }) {
  const state = usePolling(`/api/nodes/${encodeURIComponent(nodeId)}/blocks/${hash}`);
  // A 404 is meaningful here: the block isn't (or is no longer) in THIS node's chain.
  if (state.error?.status === 404) {
    return (
      <StateMessage kind="empty" title={`Not in ${nodeId}'s chain`}>
        Block <Hash value={hash} /> isn't part of this node's current chain. Either this node never
        received it, or it was abandoned in a reorganization.
      </StateMessage>
    );
  }
  return (
    <Loadable state={state} label="block">
      {(block) => <BlockDetail block={block} onSelect={onSelect} />}
    </Loadable>
  );
}

export function BlockDetail({ block, onSelect }) {
  return (
    <article className="block-detail">
      <header className="detail-head">
        <h2>Block #{block.height}</h2>
        {block.isGenesis && <Badge tone="accent">Genesis</Badge>}
        {block.isGenesis
          ? <Badge tone="neutral">Exempt from proof-of-work</Badge>
          : <Badge tone={block.meetsDifficulty ? 'ok' : 'danger'}>
              {block.meetsDifficulty ? 'Proof-of-work ✓' : 'Proof-of-work missing'}
            </Badge>}
      </header>

      <dl className="fields">
        <dt>Hash</dt>
        <dd><Hash value={block.hash} full zeros /> <CopyButton value={block.hash} /></dd>
        <dt>Previous hash</dt>
        <dd>
          {block.isGenesis
            ? <><Hash value={block.previousHash} full /> <span className="muted">(none — first block)</span></>
            : <button type="button" className="link" onClick={() => onSelect(block.previousHash)}>
                <Hash value={block.previousHash} full zeros />
              </button>}
        </dd>
        <dt>Timestamp</dt>
        <dd>{formatDateTime(block.timestamp)}</dd>
        <dt>Mining nonce</dt>
        <dd>{block.nonce} <span className="muted">{block.isGenesis ? '(never mined)' : `(${formatCoins(block.nonce + 1)} hashes tried)`}</span></dd>
        <dt>Confirmations</dt>
        <dd>{block.confirmations} <span className="muted">(this block + blocks built on top)</span></dd>
      </dl>

      {block.isGenesis ? (
        <>
          <h3>Initial allocation</h3>
          <p className="muted small">
            Coins are created only here. No signature: every node hard-codes this exact genesis.
          </p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Account</th><th className="num">Fictional coins</th></tr></thead>
              <tbody>
                {block.allocation.map((a) => (
                  <tr key={a.address}>
                    <td><Address address={a.address} label={a.label} full /></td>
                    <td className="num">{formatCoins(a.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <h3>Transactions ({block.transactions.length})</h3>
          <TransactionTable transactions={block.transactions} showBlock={false} />
        </>
      )}

      <details className="raw">
        <summary>Raw JSON</summary>
        <pre>{JSON.stringify(block, null, 2)}</pre>
      </details>
    </article>
  );
}
