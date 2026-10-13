# Demo and recording guide

This guide covers the screenshots in this repository, and scripts for recording short demos of MiniChain. Every scenario runs locally with fictional coins.

## Screenshots in `docs/screenshots/`

| File | Shows | How it was produced |
|---|---|---|
| `overview.png` | One node's stats: height, tip, work, validation, peers, pending, contracts, supply | Seeded network, Overview tab |
| `network-fork.png` | Charlie on a shorter branch; the chain-comparison grid highlights the split | `npm run demo:explorer -- --fork`, Network tab, `#network/charlie` |
| `mempool.png` | Per-node mempool sizes and the propagation matrix (pending, unknown, confirmed) | Charlie partitioned (`p`) after two `t` transfers, Mempool tab |
| `contracts.png` | Escrows in three states (claimed, funding, funded with a pending claim) | `d`, `m`, `c`, `m` plus a partial deposit, Contracts tab |
| `transactions.png` | Confirmed transfers and contract calls with the real direction of coin flow | Transactions tab |
| `balances.png` | Balances, coins locked in contracts, and the conservation check | Balances tab |

All addresses in the screenshots are random, throwaway demo wallets.

**More screenshots you could add:**
- A block detail panel (Blocks tab → click a block), showing the highlighted proof-of-work zeros.
- A contract detail panel (Contracts tab → click a contract), showing the timelock window bar and activity.
- The terminal during a reorg (`f` then `s`), showing the `↺ REORG` and `↺ recovered` lines.
- The offline state: stop the explorer while the page is open.

## Recording 1: "pending → propagated → confirmed" (about 45 s)

1. `npm run explorer` and open `http://127.0.0.1:5180/#mempool/alice`.
2. Press **`t`** twice. The terminal shows `✚ submitted` on alice and `⇠ pending … (relayed from alice)` on bob and charlie. In the browser, the rows read "Pending on 3/3".
3. Press **`m`**. The terminal shows `✔ confirmed` on every node, and the rows turn "Confirmed everywhere".

## Recording 2: "partition, fork and reorganization" (about 60 s)

1. Open `#network/charlie`.
2. Press **`f`**. The banner says "Fork: 2 different chain tips", and Charlie's cells turn red.
3. Press **`t`** then **`r`**. Charlie reconnects but **doesn't** sync, and he rejects the new transfer with "Nonce … skips ahead" because he hasn't seen Alice's block yet.
4. Press **`s`**. The terminal shows `↺ REORG abandoned 1 block(s), adopted 2` and `↺ recovered …`. The banner returns to "All 3 nodes agree".

## Recording 3: "a timelock escrow" (about 90 s)

1. Open `#contracts/bob`.
2. Press **`d`** then **`m`**. Status: *funding 10/20*.
3. Press **`c`**: `Claim REJECTED: Insufficient funding: 10 of 20 deposited`.
4. Press **`a`** then **`m`**. Status: *funded*, phase *locked*.
5. Press **`c`**: `Claim REJECTED: Too early: claimable from block #N, this is block #M`.
6. Press **`m`** until the next block reaches the unlock height, then **`c`** and **`m`**. Status: *claimed* on every node.

## Recording 4: "contract state rolls back in a reorg" (about 30 s)

1. Open `#contracts/charlie` in one window and `#contracts/alice` in another.
2. Press **`x`**. The terminal prints `Charlie's view …: claimed on his branch → funded after the reorg`, and the claim is pending again on every node.
3. Press **`m`**. The escrow is *claimed* everywhere.

## Recording tips

- Use a terminal at least 110 columns wide; the log lines are long.
- Put the browser and terminal side by side, with the browser at 1280–1440 px wide.
- On macOS, the built-in screen recorder (Shift ⌘ 5) works well. For terminal-only clips, a terminal recorder that exports a GIF or cast keeps the files small.
- Before recording, restart the explorer (`q`, then `npm run explorer`) so the block heights start small.
