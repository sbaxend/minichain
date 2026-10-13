import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ContractDetail, ContractList, phaseExplanation } from './Contracts.jsx';
import { TransactionTable } from './Transactions.jsx';
import { BalanceTable } from './Balances.jsx';
import { ALICE, BOB, CONTRACT_ID, claimTx, contract, contractDetail, tx } from '../test/fixtures.js';

describe('ContractList', () => {
  test('shows id, type, parties, amount, status, phase and heights', () => {
    render(<ContractList contracts={[{ ...contract, pendingOps: 1 }]} onSelect={() => {}} />);
    const [row] = screen.getAllByRole('row').slice(1);
    expect(within(row).getByTitle(CONTRACT_ID)).toBeTruthy();
    expect(within(row).getByText('Timelock escrow')).toBeTruthy();
    expect(within(row).getByText('Alice')).toBeTruthy();
    expect(within(row).getByText('Bob')).toBeTruthy();
    expect(within(row).getByTitle(ALICE)).toBeTruthy(); // real address next to the name
    expect(within(row).getByText('20 / 20')).toBeTruthy();
    expect(within(row).getByText('funded')).toBeTruthy();
    expect(within(row).getByText('locked')).toBeTruthy();
    expect(within(row).getByText('#6')).toBeTruthy();
    expect(within(row).getByText('#10')).toBeTruthy();
    expect(within(row).getByText('#3')).toBeTruthy();
    expect(within(row).getByText('1 pending')).toBeTruthy();
  });

  test('clicking a row selects the contract', () => {
    const onSelect = vi.fn();
    render(<ContractList contracts={[contract]} onSelect={onSelect} />);
    fireEvent.click(screen.getAllByRole('row')[1]);
    expect(onSelect).toHaveBeenCalledWith(CONTRACT_ID);
  });

  test('empty state explains how to deploy one', () => {
    render(<ContractList contracts={[]} onSelect={() => {}} />);
    expect(screen.getByText('No contracts on this chain')).toBeTruthy();
  });
});

describe('ContractDetail', () => {
  test('shows terms, a plain-English phase, activity with coin flow, and pending calls', () => {
    const pending = [{ ...claimTx, status: 'pending', kind: 'claim', nonce: 0 }];
    render(<ContractDetail contract={contractDetail({ pending })} />);
    expect(screen.getByText(/Fully funded and locked. Bob can claim from block #6 \(1 more block\)/)).toBeTruthy();
    expect(screen.getByText(CONTRACT_ID)).toBeTruthy();
    expect(screen.getByText(/claimable #6 → refundable #10/)).toBeTruthy();
    expect(screen.getByText('Activity (2)')).toBeTruthy();
    expect(screen.getByText('Pending calls (1)')).toBeTruthy();
    expect(screen.getAllByText('Escrow contract').length).toBeGreaterThan(0);
    expect(screen.getByRole('img', { name: /Claim window blocks 6 to 9/ })).toBeTruthy();
  });

  test('phase explanations cover the whole life cycle', () => {
    const at = (phase, extra = {}) => phaseExplanation({ ...contract, phase, ...extra });
    expect(at('funding', { balance: 5 })).toMatch(/5 of 20 deposited/);
    expect(at('claimable')).toMatch(/Bob can claim now — any block before #10/);
    expect(at('refundable')).toMatch(/Only Alice can take the 20 coins back/);
    expect(at('claimed', { updatedAt: 7 })).toMatch(/Bob claimed it in block #7/);
    expect(at('refunded', { updatedAt: 11 })).toMatch(/Alice was refunded in block #11/);
  });
});

describe('Transactions show contract calls', () => {
  test('a claim shows its type and flows FROM the contract TO Bob', () => {
    render(<TransactionTable transactions={[claimTx, { ...tx, kind: 'transfer' }]} />);
    const [claimRow, transferRow] = screen.getAllByRole('row').slice(1);
    expect(within(claimRow).getByText('claim')).toBeTruthy();
    const cells = within(claimRow).getAllByRole('cell');
    expect(within(cells[3]).getByText('Escrow contract')).toBeTruthy(); // From
    expect(within(cells[4]).getByText('Bob')).toBeTruthy(); // To
    expect(within(transferRow).getByText('transfer')).toBeTruthy();
  });
});

describe('Balances with contracts', () => {
  test('locked coins are shown and counted in the conservation check', () => {
    const accounts = [
      { address: ALICE, label: 'Alice', balance: 60, nextNonce: 1 },
      { address: BOB, label: 'Bob', balance: 20, nextNonce: 0 },
    ];
    render(<BalanceTable accounts={accounts} totalSupply={100} locked={20} />);
    expect(screen.getByText('Locked in contracts')).toBeTruthy();
    expect(screen.getByText(/= total supply \(100\)/)).toBeTruthy();
  });
});
