# MiniChain milestones

MiniChain was built in nine milestones. Each one added one concept, with tests and a runnable demo, without breaking the earlier ones. Coins are fictional and everything runs locally.

---

## 1. SHA-256 hashing

**Added:** `src/hash.js`, a single `sha256()` built on Node's `crypto`.

**Concepts:** determinism, fixed-length output, and the avalanche effect: a one-character change produces an unrelated hash.

**Demo:** `npm run demo:hash`, or `npm run demo:hash -- "your text"`.

## 2. Blocks and chain validation

**Added:** `Block`, `Blockchain`, and `serialize()`.

**Concepts:**
- Each block stores its predecessor's hash, so editing a block breaks either its own hash or the next block's link.
- **Canonical serialization** (JSON with sorted keys) replaces string concatenation. Concatenation is ambiguous: `"1"+"23"` and `"12"+"3"` both give `"123"`.

**Demo:** `npm run demo:chain` shows tampering detected at block 1, and a rehash caught at block 2.

## 3. Proof-of-work

**Added:** the mining nonce, `mine(difficulty)`, and the difficulty check in validation.

**Concepts:**
- The work is hard to find but easy to check: each extra leading hex zero means about 16× more hashing.
- Genesis is hard-coded and exempt from proof-of-work.
- Rewriting history now costs work. It's still possible, though, which motivates consensus in Milestone 6.

**Demo:** `npm run demo:mining` compares expected attempts with measured ones at difficulties 1–4.

## 4. Wallets and digital signatures

**Added:** `Wallet` (Ed25519 via Node `crypto`), `Transaction`, and `address.js`.

**Concepts:**
- Addresses are a hash of the public key, and the private key lives in a `#private` field.
- Verification checks both that the public key matches the sender address and that the signature is valid.
- A valid signature proves **authorization**, not funds.

**Demo:** `npm run demo:wallets` shows three forgery attempts by Bob, all rejected.

## 5. Balances and double-spending

**Added:** `Ledger extends Blockchain`, the genesis allocation, per-sender transaction nonces, and full replay validation.

**Concepts:**
- Balances are derived by replaying the chain, never stored.
- Transactions are applied sequentially, so a block can't overspend.
- Nonces must be consecutive, which protects against replay.
- Coins are conserved.

**Demo:** `npm run demo:balances` shows an insufficient-funds rejection, a replay, an overspend split across two transactions in one block, and tampering followed by re-mining.

## 6. Peer-to-peer networking and proof-of-work consensus

**Added:** `node.js`, `peer.js`, `protocol.js` and `consensus.js`.

**Concepts:**
- Nodes communicate over TCP on localhost using newline-delimited JSON with strict schemas and a handshake that checks the genesis and difficulty.
- Fork choice uses **accumulated work**, calculated locally; ties keep the current chain.
- Chain replacement is atomic, reorganizations report their orphaned transactions, and peers that send invalid chains are disconnected.

**Demo:** `npm run demo:network`: partition → fork → reconnect → reorg → three malicious chains rejected.

## 7. React blockchain explorer

**Added:**
- `api.js`: a read-only HTTP API that allows only `GET`, binds to `127.0.0.1`, checks the `Host` header, limits sizes, and sets a CSP on the built UI.
- `demo-network.js`.
- `frontend/`: React + Vite.

**Concepts:** polling without overlapping requests or stale responses; showing each node's **own** view; fork visualization; loading, empty, offline and error states.

**Demo:** `npm run explorer` (keys `m`, `f`, `s`).

## 8. Mempool and transaction gossip

**Added:** `mempool.js`; protocol messages `NEW_TX`, `GET_MEMPOOL` and `MEMPOOL` (`minichain/2`); `mineFromMempool()`; pending views in the API and UI.

**Concepts:**
- Each node checks transactions independently.
- Admission is conservative: contiguous nonces, reserved pending spends, and pending incoming coins don't count.
- The difference between known, rejected and faulty transactions; gossip without loops; mempool exchange on reconnection without syncing chains.
- The pool is revalidated after every block or reorg, and orphans are recovered within a limit.

**Demo:** explorer keys `t`, `m`, `n`, `p`, `r`.

## 9. Deterministic smart contracts

**Added:** `contracts.js` (the timelock-escrow template, executor and limits); an optional `contract` field on transactions (`minichain/3`); contract state in the ledger; contract API endpoints and a Contracts view.

**Concepts:**
- Contracts are data, not code.
- **Block height is the only clock.**
- Operations are atomic, and a failing operation invalidates its transaction.
- Contract IDs are deterministic and commit to the terms.
- Execution is bounded by a step meter and limits on storage, transaction size, contract count and lock length.
- Reorgs roll contract state back automatically.

**Demo:** explorer keys `d`, `a`, `c`, `e`, `x`.

---

## Protocol versions

| Version | Introduced in | Change |
|---|---|---|
| `minichain/1` | Milestone 6 | Handshake, blocks, chain sync |
| `minichain/2` | Milestone 8 | Transaction gossip and mempool sync |
| `minichain/3` | Milestone 9 | Contract calls in transactions; contract rules in block validation |

Nodes refuse peers that speak a different version at the handshake, rather than failing later.
