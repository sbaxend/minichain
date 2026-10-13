import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import App from './App.jsx';
import {
  CONTRACT_ID, blocks, contract, contractDetail, networkFixture, networkMempoolFixture, nodeMempool, summary, tx,
} from './test/fixtures.js';

/** Route fake API responses by URL; record which URLs were requested. */
function mockApi(routes) {
  const requested = [];
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    requested.push(url);
    const match = Object.keys(routes).find((prefix) => url === prefix || url.startsWith(`${prefix}?`));
    if (!match) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    return new Response(JSON.stringify(routes[match]), { status: 200 });
  }));
  return requested;
}

afterEach(() => {
  vi.unstubAllGlobals();
  // The app stores the current view in the URL hash; jsdom keeps the URL
  // between tests, so reset it to keep tests independent.
  window.history.replaceState(null, '', '/');
});

describe('App', () => {
  test('loads the network and shows the first node\'s overview', async () => {
    mockApi({ '/api/network': networkFixture(), '/api/nodes/alice': summary });
    render(<App />);
    expect(await screen.findByText('Chains in sync')).toBeTruthy();
    expect(await screen.findByText('Accumulated work')).toBeTruthy();
    expect(screen.getByText('Valid ✓')).toBeTruthy();
  });

  test('switching node requests that node\'s own data', async () => {
    const requested = mockApi({
      '/api/network': networkFixture({ forked: true }),
      '/api/nodes/alice': summary,
      '/api/nodes/charlie': { ...summary, id: 'charlie', height: 1, peers: [] },
    });
    render(<App />);
    expect(await screen.findByText('Fork · 2 tips')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: /charlie/ }));
    expect(await screen.findByText('not connected to anyone')).toBeTruthy();
    expect(requested).toContain('/api/nodes/charlie');
  });

  test('blocks and transactions tabs', async () => {
    mockApi({
      '/api/network': networkFixture(),
      '/api/nodes/alice': summary,
      '/api/nodes/alice/blocks': { total: 3, blocks },
      '/api/nodes/alice/transactions': { total: 1, transactions: [tx], pending: { supported: true, count: 1, note: '' } },
      '/api/nodes/alice/mempool': nodeMempool(1),
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Blocks' }));
    expect(await screen.findByText('3 in alice\'s chain')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Transactions' }));
    expect(await screen.findByText('Confirmed transactions')).toBeTruthy();
    // Milestone 8: confirmed and pending are separate filters.
    fireEvent.click(screen.getByRole('button', { name: 'Pending' }));
    expect(await screen.findByText('Pending transactions')).toBeTruthy();
    expect(screen.getByText('1 in alice\'s mempool · limit 500')).toBeTruthy();
  });

  test('pending filter follows the selected node (each node has its own mempool)', async () => {
    const requested = mockApi({
      '/api/network': networkFixture(),
      '/api/nodes/alice/transactions': { total: 0, transactions: [], pending: { supported: true, count: 1, note: '' } },
      '/api/nodes/alice/mempool': nodeMempool(1),
      '/api/nodes/charlie/mempool': { ...nodeMempool(0), nodeId: 'charlie' },
    });
    window.history.replaceState(null, '', '/#transactions/alice');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pending' }));
    expect(await screen.findByText('1 in alice\'s mempool · limit 500')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /charlie/ }));
    expect(await screen.findByText('0 in charlie\'s mempool · limit 500')).toBeTruthy();
    expect(screen.getByText('No pending transactions')).toBeTruthy();
    expect(requested).toContain('/api/nodes/charlie/mempool');
  });

  test('mempool tab compares nodes and switching node from it works', async () => {
    mockApi({
      '/api/network': networkFixture(),
      '/api/mempool': networkMempoolFixture(),
      '/api/nodes/charlie': { ...summary, id: 'charlie', peers: [] },
    });
    window.history.replaceState(null, '', '/#mempool/alice');
    render(<App />);
    expect(await screen.findByText('Transaction propagation')).toBeTruthy();
    expect(screen.getByText('Pending on 2/3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /charlie\s*0\s*pending/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Overview' }));
    expect(await screen.findByText('not connected to anyone')).toBeTruthy(); // charlie's overview
  });

  test('the URL hash selects the tab and node, and follows changes', async () => {
    window.history.replaceState(null, '', '/#balances/bob');
    mockApi({
      '/api/network': networkFixture(),
      '/api/nodes/bob/balances': { nodeId: 'bob', height: 2, unit: 'fictional MiniChain coins', totalSupply: 0, accounts: [] },
    });
    render(<App />);
    expect(await screen.findByText('No accounts')).toBeTruthy();
    expect(screen.getByRole('button', { name: /bob/ }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Network' }));
    expect(await screen.findByText(/All 3 nodes agree/)).toBeTruthy();
    expect(window.location.hash).toBe('#network/bob');
  });

  test('contracts tab: list, detail, and a node that does not have the contract', async () => {
    mockApi({
      '/api/network': networkFixture(),
      '/api/nodes/alice/contracts': { nodeId: 'alice', height: 4, nextHeight: 5, count: 1, limit: 100, contracts: [contract] },
      [`/api/nodes/alice/contracts/${CONTRACT_ID}`]: contractDetail(),
      '/api/nodes/charlie/contracts': { nodeId: 'charlie', height: 4, nextHeight: 5, count: 0, limit: 100, contracts: [] },
    });
    window.history.replaceState(null, '', '/#contracts/alice');
    render(<App />);
    expect(await screen.findByText('1 in alice\'s chain · limit 100 · next block #5')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('row')[1]);
    expect(await screen.findByText('Activity (2)')).toBeTruthy();
    // Charlie's chain (e.g. another branch) doesn't contain it: his own view says so.
    fireEvent.click(screen.getByRole('button', { name: /charlie/ }));
    expect(await screen.findByText('No contracts on this chain')).toBeTruthy();
    expect(await screen.findByText('Not in charlie\'s chain')).toBeTruthy();
  });

  test('shows a helpful offline message when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    render(<App />);
    expect(await screen.findByText('API offline')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/npm run explorer/);
  });
});
