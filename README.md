# Sylox Protocol

Sylox gives every anchor-issued token on Stellar a public risk score and
a market where holders can insure against that issuer depegging, freezing
withdrawals, or failing.

Status: pre-protocol, design validated against `prd.md`, implementation not
started. See `technical-doc.md` for the full engineering specification.

## Documents

- [`prd.md`](./prd.md): product requirements, protocol scope, SCF application plan.
- [`technical-doc.md`](./technical-doc.md): contracts, data model, math, APIs, deployment and ops. Starts with the v1.1 changelog.
- [`docs/decisions/`](./docs/decisions/): architecture decision records (ADR-001 to ADR-006) behind spec v1.1.

## Repository layout

```
contracts/
  types/            # shared #[contracttype]s imported by every contract
  risk-oracle/       # signals, score, bands (technical-doc.md Section 5-6)
  event-registry/    # credit event state machine (Section 8)
  staking/           # keeper bonds, reporter stakes and probes, bond escrow, slashing (Section 7)
  treasury/          # protocol fees, slashed funds, reward pools (Section 12.7)
  market-factory/    # opens series, enforces global caps (Section 9, 11.1)
  series/            # one protection market per series (Section 9-10)
  governor/          # multisig, timelock, upgrades, pausing (Section 17)
  adapters/          # AMM price and FX reference adapters (Section 3.3)
services/
  keeper/            # computes and posts signals
  reporter-node/     # probes anchor endpoints
  indexer/           # contract events into queryable history
  api/               # public read-only REST/WebSocket API
packages/
  sdk/               # @sylox/sdk, TypeScript client
  recompute/         # deterministic signal recomputation tool
deploy/
  testnet.toml, mainnet.toml, deploy.sh
tests/
  integration/, scenarios/, property/
```

## Status

All seven contracts currently build as stubs (`todo!()` bodies) to prove out
the workspace, shared types, and Soroban test harness end to end. No
contract logic is implemented yet; the shared types in `contracts/types`
match spec v1.1 and have encoding tests. See `technical-doc.md` Section 1.2 for
what's in and out of scope for v1.

## Building

Requires Rust with the `wasm32v1-none` target and the Stellar CLI.

```sh
cargo check --workspace
cargo test --workspace
cargo build --target wasm32v1-none --release
```

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
