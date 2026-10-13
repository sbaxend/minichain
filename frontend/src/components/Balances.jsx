import { usePolling } from '../hooks/usePolling.js';
import { formatCoins } from '../format.js';
import { Address, Badge, Loadable, StateMessage } from './ui.jsx';

export function BalancesView({ nodeId }) {
  const state = usePolling(`/api/nodes/${encodeURIComponent(nodeId)}/balances`);
  return (
    <Loadable state={state} label="balances">
      {(data) => (
        <section className="panel">
          <div className="panel-head">
            <h2>Balances</h2>
            <span className="muted">as seen by {nodeId} at height {data.height}</span>
          </div>
          <BalanceTable accounts={data.accounts} totalSupply={data.totalSupply} locked={data.lockedInContracts ?? 0} />
        </section>
      )}
    </Loadable>
  );
}

/** `locked` = coins held by escrow contracts (owned by no account until claimed or refunded). */
export function BalanceTable({ accounts, totalSupply, locked = 0 }) {
  if (!accounts.length) return <StateMessage kind="empty" title="No accounts" />;
  const sum = accounts.reduce((total, a) => total + a.balance, 0) + locked;
  return (
    <>
      <p className="notice">
        <Badge tone="warn">Fictional coins</Badge> Educational only — no real value. Balances are
        recalculated by replaying this node's chain from genesis.
      </p>
      <div className="table-wrap">
        <table className="balances">
          <thead>
            <tr>
              <th>Account</th>
              <th className="num">Balance</th>
              <th>Share of supply</th>
              <th className="num">Next tx nonce</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.address}>
                <td><Address address={a.address} label={a.label} full /></td>
                <td className="num amount">{formatCoins(a.balance)}</td>
                <td>
                  <progress value={a.balance} max={totalSupply || 1} aria-label={`${a.label ?? a.address} share`} />
                </td>
                <td className="num">{a.nextNonce}</td>
              </tr>
            ))}
            {locked > 0 && (
              <tr>
                <td><span className="name">Locked in contracts</span> <span className="muted small">escrows not yet claimed or refunded</span></td>
                <td className="num amount">{formatCoins(locked)}</td>
                <td><progress value={locked} max={totalSupply || 1} aria-label="locked share" /></td>
                <td className="num"><span className="muted">—</span></td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td className="num amount">{formatCoins(sum)}</td>
              <td colSpan={2}>
                {sum === totalSupply
                  ? <Badge tone="ok">= total supply ({formatCoins(totalSupply)}) ✓</Badge>
                  : <Badge tone="danger">≠ total supply ({formatCoins(totalSupply)})</Badge>}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}
