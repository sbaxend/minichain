/**
 * Shapes copied from the real API (see src/api.js in the project root).
 * Used only by tests.
 */
export const HASH = (c) => `00${c.repeat(62)}`;
export const ALICE = `MC${'a'.repeat(40)}`;
export const BOB = `MC${'b'.repeat(40)}`;

export const blocks = [
  { height: 2, hash: HASH('c'), previousHash: HASH('b'), timestamp: 3000, nonce: 41, isGenesis: false, transactionCount: 2, confirmations: 1 },
  { height: 1, hash: HASH('b'), previousHash: HASH('a'), timestamp: 2000, nonce: 7, isGenesis: false, transactionCount: 1, confirmations: 2 },
  { height: 0, hash: 'f'.repeat(64), previousHash: '0'.repeat(64), timestamp: 0, nonce: 0, isGenesis: true, transactionCount: 0, confirmations: 3 },
];

export const tx = {
  id: 'd'.repeat(64),
  status: 'confirmed',
  sender: ALICE,
  senderLabel: 'Alice',
  recipient: BOB,
  recipientLabel: 'Bob',
  amount: 10,
  nonce: 0,
  timestamp: 2000,
  signatureValid: true,
  blockHeight: 1,
  blockHash: HASH('b'),
  confirmations: 2,
};

export function networkFixture({ forked = false } = {}) {
  const genesis = { height: 0, hash: 'f'.repeat(64) };
  const main = [genesis, { height: 1, hash: HASH('b') }, { height: 2, hash: HASH('c') }];
  const charlieFork = [genesis, { height: 1, hash: HASH('9') }]; // his own block at height 1
  const node = (id, recent, peers) => ({
    id,
    height: recent.at(-1).height,
    tipHash: recent.at(-1).hash,
    work: String(256 * recent.at(-1).height),
    peers,
    valid: true,
    recent,
  });
  const nodes = forked
    ? [node('alice', main, ['bob']), node('bob', main, ['alice']), node('charlie', charlieFork, [])]
    : [node('alice', main, ['bob', 'charlie']), node('bob', main, ['alice', 'charlie']), node('charlie', main, ['alice', 'bob'])];
  return {
    inSync: !forked,
    distinctTips: forked ? 2 : 1,
    commonHeight: forked ? 0 : 2,
    bestHeight: 2,
    nodes,
  };
}

export const summary = {
  id: 'alice',
  p2pPort: 60000,
  height: 2,
  tipHash: HASH('c'),
  genesisHash: 'f'.repeat(64),
  difficulty: 2,
  protocol: 'minichain/1',
  work: '512',
  validation: { valid: true },
  peers: ['bob', 'charlie'],
  totalSupply: 300,
  unit: 'fictional MiniChain coins',
  recentBlocks: blocks,
};

/** A pending transaction as /api/nodes/:id/mempool returns it. */
export const pendingTx = {
  id: 'e'.repeat(64),
  status: 'pending',
  sender: ALICE,
  senderLabel: 'Alice',
  recipient: BOB,
  recipientLabel: 'Bob',
  amount: 1,
  nonce: 3,
  timestamp: 4000,
  receivedAt: 4000,
  source: 'bob',
  signatureValid: true,
};

export const nodeMempool = (count = 1) => ({
  nodeId: 'alice',
  height: 2,
  count,
  limits: { maxSize: 500, maxPerSender: 25, maxTxBytes: 2048 },
  transactions: count ? [pendingTx] : [],
});

/** /api/mempool: one tx pending on alice + bob (charlie partitioned), one confirmed everywhere. */
export function networkMempoolFixture({ inSync = false } = {}) {
  const pendingRow = {
    id: pendingTx.id, sender: ALICE, senderLabel: 'Alice', recipient: BOB, recipientLabel: 'Bob',
    amount: 1, nonce: 3, timestamp: 4000,
    statusByNode: inSync
      ? { alice: { status: 'pending', source: 'local' }, bob: { status: 'pending', source: 'alice' }, charlie: { status: 'pending', source: 'alice' } }
      : { alice: { status: 'pending', source: 'local' }, bob: { status: 'pending', source: 'alice' }, charlie: { status: 'unknown' } },
    pendingOn: inSync ? 3 : 2, confirmedOn: 0, unknownOn: inSync ? 0 : 1,
  };
  const confirmedRow = {
    id: tx.id, sender: ALICE, senderLabel: 'Alice', recipient: BOB, recipientLabel: 'Bob',
    amount: 10, nonce: 0, timestamp: 2000,
    statusByNode: { alice: { status: 'confirmed', blockHeight: 1 }, bob: { status: 'confirmed', blockHeight: 1 }, charlie: { status: 'confirmed', blockHeight: 1 } },
    pendingOn: 0, confirmedOn: 3, unknownOn: 0,
  };
  return {
    inSync,
    nodes: [
      { id: 'alice', pendingCount: 1, missing: 0 },
      { id: 'bob', pendingCount: 1, missing: 0 },
      { id: 'charlie', pendingCount: inSync ? 1 : 0, missing: inSync ? 0 : 1 },
    ],
    transactions: [pendingRow, confirmedRow],
  };
}

/** A contract as /api/nodes/:id/contracts returns it. */
export const CONTRACT_ID = `CT${'1'.repeat(40)}`;
export const contract = {
  id: CONTRACT_ID,
  template: 'timelock-escrow',
  type: 'Timelock escrow',
  creator: ALICE,
  creatorLabel: 'Alice',
  beneficiary: BOB,
  beneficiaryLabel: 'Bob',
  amount: 20,
  balance: 20,
  status: 'funded',
  phase: 'locked',
  unlockHeight: 6,
  expiryHeight: 10,
  deployedAt: 3,
  updatedAt: 4,
  nextHeight: 5,
  pendingOps: 0,
};

export const contractDetail = (overrides = {}) => ({
  ...contract,
  activity: [
    { id: 'f'.repeat(64), kind: 'fund', status: 'confirmed', blockHeight: 4, amount: 10, nonce: 1,
      flow: { from: ALICE, fromLabel: 'Alice', to: CONTRACT_ID, toLabel: 'Escrow contract' } },
    { id: '9'.repeat(64), kind: 'deploy', status: 'confirmed', blockHeight: 3, amount: 10, nonce: 0,
      flow: { from: ALICE, fromLabel: 'Alice', to: CONTRACT_ID, toLabel: 'Escrow contract' } },
  ],
  pending: [],
  ...overrides,
});

/** A confirmed claim as /transactions returns it: coins flow OUT of the contract. */
export const claimTx = {
  ...tx,
  id: '8'.repeat(64),
  kind: 'claim',
  contractId: CONTRACT_ID,
  sender: BOB,
  senderLabel: 'Bob',
  recipient: CONTRACT_ID,
  recipientLabel: null,
  amount: 20,
  flow: { from: CONTRACT_ID, fromLabel: 'Escrow contract', to: BOB, toLabel: 'Bob' },
};
