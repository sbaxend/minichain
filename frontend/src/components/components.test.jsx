import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { BlockList, BlockDetail } from './Blocks.jsx';
import { PendingTable, TransactionTable, sourceLabel } from './Transactions.jsx';
import { BalanceTable } from './Balances.jsx';
import { NetworkContent, NodeSwitcher } from './Network.jsx';
import { OverviewContent } from './Overview.jsx';
import { MempoolContent } from './Mempool.jsx';
import { Loadable } from './ui.jsx';
import {
  ALICE, BOB, blocks, networkFixture, networkMempoolFixture, pendingTx, summary, tx,
} from '../test/fixtures.js';

describe('BlockList', () => {
  test('shows heights, transaction counts, and marks genesis distinctly', () => {
    render(<BlockList blocks={blocks} onSelect={() => {}} />);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText('#2')).toBeTruthy();
    expect(within(rows[0]).getByText('2')).toBeTruthy(); // tx count
    expect(within(rows[2]).getByText('Genesis')).toBeTruthy();
    expect(rows[2].className).toContain('genesis');
  });

  test('clicking or pressing Enter on a row selects that block', () => {
    const onSelect = vi.fn();
    render(<BlockList blocks={blocks} onSelect={onSelect} />);
    const rows = screen.getAllByRole('row').slice(1);
    fireEvent.click(rows[1]);
    fireEvent.keyDown(rows[0], { key: 'Enter' });
    expect(onSelect.mock.calls).toEqual([[blocks[1].hash], [blocks[0].hash]]);
  });

  test('empty list', () => {
    render(<BlockList blocks={[]} onSelect={() => {}} />);
    expect(screen.getByText('No blocks')).toBeTruthy();
  });
});

describe('BlockDetail', () => {
  test('shows full hashes, nonce, proof-of-work, and transactions', () => {
    const onSelect = vi.fn();
    render(<BlockDetail block={{ ...blocks[1], meetsDifficulty: true, transactions: [tx] }} onSelect={onSelect} />);
    expect(screen.getByText('Block #1')).toBeTruthy();
    expect(screen.getByText('Proof-of-work ✓')).toBeTruthy();
    expect(screen.getByText(/8 hashes tried/)).toBeTruthy();
    expect(screen.getAllByTitle(blocks[1].hash).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByTitle(blocks[1].previousHash).closest('button'));
    expect(onSelect).toHaveBeenCalledWith(blocks[1].previousHash);
  });

  test('genesis shows the allocation instead of transactions', () => {
    const genesis = { ...blocks[2], meetsDifficulty: false, allocation: [{ address: ALICE, amount: 100, label: 'Alice' }] };
    render(<BlockDetail block={genesis} onSelect={() => {}} />);
    expect(screen.getByText('Exempt from proof-of-work')).toBeTruthy();
    expect(screen.getByText('Initial allocation')).toBeTruthy();
    expect(screen.queryByText(/Transactions \(/)).toBe(null);
    expect(screen.getByText(ALICE)).toBeTruthy(); // full address
  });
});

describe('TransactionTable', () => {
  test('shows confirmed status, names alongside addresses, amount, nonce, signature', () => {
    const onOpenBlock = vi.fn();
    render(<TransactionTable transactions={[tx]} onOpenBlock={onOpenBlock} />);
    expect(screen.getByText('Confirmed')).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByTitle(ALICE)).toBeTruthy(); // the real address is still there
    expect(screen.getByTitle(BOB)).toBeTruthy();
    expect(screen.getByText('Valid ✓')).toBeTruthy();
    fireEvent.click(screen.getByText('#1'));
    expect(onOpenBlock).toHaveBeenCalledWith(tx.blockHash);
  });

  test('unknown addresses are marked Unlabeled, not invented', () => {
    render(<TransactionTable transactions={[{ ...tx, recipientLabel: null }]} />);
    expect(screen.getByText('Unlabeled')).toBeTruthy();
  });

  test('empty state', () => {
    render(<TransactionTable transactions={[]} />);
    expect(screen.getByText('No confirmed transfers yet')).toBeTruthy();
  });

});

// Milestone 8: the "no mempool" notice was replaced by real pending data.
describe('PendingTable', () => {
  test('shows pending status, tx id, names + addresses, amount, nonce, and where it came from', () => {
    render(<PendingTable transactions={[pendingTx]} />);
    expect(screen.getByText('Pending')).toBeTruthy();
    expect(screen.queryByText('Confirmed')).toBe(null); // never shown as confirmed
    expect(screen.getByTitle(pendingTx.id)).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByTitle(ALICE)).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy(); // tx nonce
    expect(screen.getByText(/relayed by bob/)).toBeTruthy();
    expect(screen.getByText('Valid ✓')).toBeTruthy();
  });

  test('empty mempool explains how to create a pending tx', () => {
    render(<PendingTable transactions={[]} />);
    expect(screen.getByText('No pending transactions')).toBeTruthy();
    expect(screen.getByText('t')).toBeTruthy();
  });

  test('source labels', () => {
    expect(sourceLabel('local')).toBe('submitted here');
    expect(sourceLabel('orphan-recovery')).toBe('recovered after reorg');
    expect(sourceLabel('charlie')).toBe('relayed by charlie');
  });
});

describe('MempoolContent', () => {
  test('shows per-node counts, missing txs, and each node\'s view of each tx', () => {
    render(<MempoolContent data={networkMempoolFixture()} selectedId="alice" onSelect={() => {}} />);
    expect(screen.getByText(/Mempools differ/)).toBeTruthy();
    expect(screen.getByText('missing 1')).toBeTruthy(); // charlie
    const rows = screen.getAllByRole('row').slice(1);
    const pendingRow = rows[0];
    expect(within(pendingRow).getAllByText('Pending')).toHaveLength(2); // alice + bob
    expect(within(pendingRow).getByText('—')).toBeTruthy(); // charlie hasn't seen it
    expect(within(pendingRow).getByText('Pending on 2/3')).toBeTruthy();
    expect(within(rows[1]).getAllByText('Confirmed #1')).toHaveLength(3);
    expect(within(rows[1]).getByText('Confirmed everywhere')).toBeTruthy();
  });

  test('in-sync banner when every mempool matches', () => {
    render(<MempoolContent data={networkMempoolFixture({ inSync: true })} selectedId="alice" onSelect={() => {}} />);
    expect(screen.getByText('All mempools match.')).toBeTruthy();
  });

  test('"Pending only" hides confirmed rows', () => {
    render(<MempoolContent data={networkMempoolFixture()} selectedId="alice" onSelect={() => {}} />);
    expect(screen.getAllByRole('row')).toHaveLength(3);
    fireEvent.click(screen.getByLabelText('Pending only'));
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.queryByText('Confirmed everywhere')).toBe(null);
  });

  test('clicking a node card selects that node', () => {
    const onSelect = vi.fn();
    render(<MempoolContent data={networkMempoolFixture()} selectedId="alice" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /charlie/ }));
    expect(onSelect).toHaveBeenCalledWith('charlie');
  });

  test('empty state when nothing is pending or recent', () => {
    render(<MempoolContent data={{ inSync: true, nodes: [{ id: 'alice', pendingCount: 0, missing: 0 }], transactions: [] }} selectedId="alice" onSelect={() => {}} />);
    expect(screen.getByText('No transactions to show')).toBeTruthy();
  });
});

describe('BalanceTable', () => {
  const accounts = [
    { address: ALICE, label: 'Alice', balance: 70, nextNonce: 1 },
    { address: BOB, label: null, balance: 30, nextNonce: 0 },
  ];

  test('shows full addresses with names, fictional label, and conservation check', () => {
    render(<BalanceTable accounts={accounts} totalSupply={100} />);
    expect(screen.getByText('Fictional coins')).toBeTruthy();
    expect(screen.getByText(ALICE)).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('Unlabeled')).toBeTruthy();
    expect(screen.getByText(/= total supply/)).toBeTruthy();
  });

  test('flags balances that do not add up to the supply', () => {
    render(<BalanceTable accounts={accounts} totalSupply={150} />);
    expect(screen.getByText(/≠ total supply/)).toBeTruthy();
  });
});

describe('Network views', () => {
  test('in-sync banner when all tips match', () => {
    render(<NetworkContent data={networkFixture()} selectedId="alice" onSelect={() => {}} />);
    expect(screen.getByText(/All 3 nodes agree/)).toBeTruthy();
    expect(screen.queryByText('Forked')).toBe(null);
  });

  test('fork banner and the diverged node is highlighted', () => {
    render(<NetworkContent data={networkFixture({ forked: true })} selectedId="alice" onSelect={() => {}} />);
    expect(screen.getByText(/Fork: 2 different chain tips/)).toBeTruthy();
    const charlieRow = screen.getAllByRole('row').find((r) => within(r).queryByText('charlie') && within(r).queryByText('Forked'));
    expect(charlieRow).toBeTruthy();
    expect(document.querySelectorAll('.cell-fork').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.cell-missing').length).toBeGreaterThan(0); // charlie has no block #2
  });

  test('node switcher shows each node\'s pending count', () => {
    const nodes = networkFixture().nodes.map((n, i) => ({ ...n, pendingCount: i }));
    render(<NodeSwitcher nodes={nodes} selectedId="alice" onSelect={() => {}} />);
    expect(within(screen.getByRole('button', { name: /bob/ })).getByText('1 pending')).toBeTruthy();
    expect(within(screen.getByRole('button', { name: /alice/ })).queryByText(/pending/)).toBe(null);
  });

  test('node switcher marks the active and forked nodes and switches on click', () => {
    const onSelect = vi.fn();
    render(<NodeSwitcher nodes={networkFixture({ forked: true }).nodes} selectedId="alice" onSelect={onSelect} />);
    expect(screen.getByRole('button', { name: /alice/ }).getAttribute('aria-pressed')).toBe('true');
    const charlie = screen.getByRole('button', { name: /charlie/ });
    expect(within(charlie).getByText('Forked')).toBeTruthy();
    fireEvent.click(charlie);
    expect(onSelect).toHaveBeenCalledWith('charlie');
  });
});

describe('Overview', () => {
  test('shows the key stats', () => {
    render(<OverviewContent summary={summary} onOpenBlock={() => {}} />);
    expect(screen.getByText('Block height')).toBeTruthy();
    expect(screen.getByText('512')).toBeTruthy(); // accumulated work
    expect(screen.getByText('Valid ✓')).toBeTruthy();
    expect(screen.getByText('300')).toBeTruthy(); // total supply
    expect(screen.getByText(/fictional coins/)).toBeTruthy();
  });

  test('shows an invalid chain clearly', () => {
    render(<OverviewContent summary={{ ...summary, validation: { valid: false, index: 2, reason: 'Invalid signature' } }} onOpenBlock={() => {}} />);
    expect(screen.getByText('Invalid at block 2')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/Invalid signature/);
  });
});

describe('Loadable states', () => {
  const child = () => <p>content</p>;
  test('loading', () => {
    render(<Loadable state={{ data: null, error: null }} label="blocks">{child}</Loadable>);
    expect(screen.getByText('Loading blocks…')).toBeTruthy();
  });
  test('offline', () => {
    render(<Loadable state={{ data: null, error: { offline: true } }} label="blocks">{child}</Loadable>);
    expect(screen.getByRole('alert').textContent).toMatch(/API is offline/);
  });
  test('error', () => {
    render(<Loadable state={{ data: null, error: { message: 'Boom' } }} label="blocks">{child}</Loadable>);
    expect(screen.getByText('Could not load blocks')).toBeTruthy();
  });
  test('stale data stays visible with a warning', () => {
    render(<Loadable state={{ data: {}, error: { offline: true } }} label="blocks">{child}</Loadable>);
    expect(screen.getByText('content')).toBeTruthy();
    expect(screen.getByText(/last known data/)).toBeTruthy();
  });
});
