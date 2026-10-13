import { useEffect, useState } from 'react';
import { usePolling } from './hooks/usePolling.js';
import { Badge, OfflineMessage, StateMessage } from './components/ui.jsx';
import { Overview } from './components/Overview.jsx';
import { BlocksView } from './components/Blocks.jsx';
import { TransactionsView } from './components/Transactions.jsx';
import { BalancesView } from './components/Balances.jsx';
import { NetworkView, NodeSwitcher } from './components/Network.jsx';
import { MempoolView } from './components/Mempool.jsx';
import { ContractsView } from './components/Contracts.jsx';

const TABS = [
  ['overview', 'Overview'],
  ['blocks', 'Blocks'],
  ['transactions', 'Transactions'],
  ['mempool', 'Mempool'],
  ['contracts', 'Contracts'],
  ['balances', 'Balances'],
  ['network', 'Network'],
];

/** The URL hash remembers the view: "#network/charlie" = Network tab, charlie's node. */
function readHash() {
  const [tab, node] = window.location.hash.replace(/^#\/?/, '').split('/');
  return {
    tab: TABS.some(([key]) => key === tab) ? tab : 'overview',
    node: node ? decodeURIComponent(node) : null,
  };
}

export default function App() {
  const network = usePolling('/api/network');
  const [chosenId, setChosenId] = useState(() => readHash().node);
  const [tab, setTab] = useState(() => readHash().tab);
  const [selectedBlock, setSelectedBlock] = useState(null);

  const nodes = network.data?.nodes ?? [];
  const nodeId = nodes.some((n) => n.id === chosenId) ? chosenId : nodes[0]?.id ?? null;

  // Keep the URL in sync so a view can be bookmarked or shared (wait until
  // the node list has loaded, so a node named in the URL isn't overwritten).
  useEffect(() => {
    if (!nodeId) return;
    const hash = `#${tab}/${encodeURIComponent(nodeId)}`;
    if (window.location.hash !== hash) window.history.replaceState(null, '', hash);
  }, [tab, nodeId]);
  // ...and follow the URL if someone edits it by hand.
  useEffect(() => {
    const onHashChange = () => {
      const { tab: t, node } = readHash();
      setTab(t);
      if (node) setChosenId(node);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  function selectNode(id) {
    setChosenId(id);
    setSelectedBlock(null); // a block hash from one node may not exist on another
  }
  function openBlock(hash) {
    setSelectedBlock(hash);
    setTab('blocks');
  }

  return (
    <div className="app">
      <Header network={network} />

      {nodes.length > 0 && <NodeSwitcher nodes={nodes} selectedId={nodeId} onSelect={selectNode} />}

      <nav className="tabs" aria-label="Sections">
        {TABS.map(([key, label]) => (
          <button
            type="button"
            key={key}
            className={key === tab ? 'active' : ''}
            aria-current={key === tab ? 'page' : undefined}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      <main>
        {!nodeId ? (
          <NoNodes network={network} />
        ) : (
          <>
            {tab === 'overview' && <Overview nodeId={nodeId} onOpenBlock={openBlock} />}
            {tab === 'blocks' && <BlocksView nodeId={nodeId} selectedHash={selectedBlock} onSelect={setSelectedBlock} />}
            {tab === 'transactions' && <TransactionsView nodeId={nodeId} onOpenBlock={openBlock} />}
            {tab === 'mempool' && <MempoolView selectedId={nodeId} onSelect={selectNode} />}
            {tab === 'contracts' && <ContractsView nodeId={nodeId} />}
            {tab === 'balances' && <BalancesView nodeId={nodeId} />}
            {tab === 'network' && <NetworkView network={network} selectedId={nodeId} onSelect={selectNode} />}
          </>
        )}
      </main>

      <footer className="footer">
        Read-only explorer · fictional coins with no real value · served from 127.0.0.1
      </footer>
    </div>
  );
}

function Header({ network }) {
  const { data, error } = network;
  let status = <Badge tone="neutral">Connecting…</Badge>;
  if (error?.offline) status = <Badge tone="danger">API offline</Badge>;
  else if (data?.inSync) status = <Badge tone="ok">Chains in sync</Badge>;
  else if (data) status = <Badge tone="warn">Fork · {data.distinctTips} tips</Badge>;

  return (
    <header className="header">
      <div className="brand">
        <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
          <rect x="5" y="11" width="9" height="10" rx="2" fill="none" stroke="#2dd4bf" strokeWidth="2" />
          <rect x="18" y="11" width="9" height="10" rx="2" fill="none" stroke="#60a5fa" strokeWidth="2" />
          <path d="M14 16h4" stroke="#8592ab" strokeWidth="2" />
        </svg>
        <div>
          <h1>MiniChain Explorer</h1>
          <p className="muted small">Local educational blockchain · read-only</p>
        </div>
      </div>
      <div className="header-status">
        {status}
        {network.updatedAt && (
          <span className="muted small">updated {new Date(network.updatedAt).toLocaleTimeString()}</span>
        )}
      </div>
    </header>
  );
}

function NoNodes({ network }) {
  if (network.error?.offline) return <OfflineMessage />;
  if (network.error) return <StateMessage kind="error" title="Could not load the network">{network.error.message}</StateMessage>;
  if (network.loading) return <StateMessage kind="loading" title="Connecting to MiniChain…" />;
  return <StateMessage kind="empty" title="No nodes">The API is running but reports no nodes.</StateMessage>;
}
