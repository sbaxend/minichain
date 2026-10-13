# Security

MiniChain is an **educational** blockchain. It is not a cryptocurrency, holds no real value, and has **no production security guarantees**.

## Intended use

- Run it on your own machine to learn how blockchains work.
- All services bind to `127.0.0.1` by default. Do not expose them to a network.
- Coins are fictional. Never use MiniChain to store, move, or represent anything of value.

## What it does protect against (by design, for teaching)

- Forged, altered, or replayed transactions (Ed25519 signatures, per-sender nonces).
- Overspending and double-spending (balances replayed from genesis; pending-balance reservation).
- Invalid blocks and chains from peers (full re-validation; most-work fork choice; peers that send provably invalid data are disconnected).
- Malformed or oversized network messages and HTTP requests (strict schemas, size limits, read-only `GET`-only API, local `Host` check).
- Arbitrary code execution through contracts (there is no VM: contracts are data checked against a fixed template).

## Known, intentional gaps

No Sybil resistance beyond proof-of-work, no encryption or authentication between nodes, no rate limiting beyond simple strike counters, no persistence, no finality, and performance that degrades with chain length (every check replays the chain). See the *Limitations* section of the [README](README.md).

## Reporting issues

Because MiniChain is local and educational, please open a regular GitHub issue for any security-related bug. Include the steps to reproduce and the output of `npm run verify`.

Wallet keys exist only in memory while a demo runs. The explorer API never receives them. If you ever find a private key in API output, logs, or the repository, please report it as a bug.
