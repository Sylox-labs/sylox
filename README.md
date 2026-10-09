# Sylox Protocol

Sylox gives every anchor-issued token on Stellar a public risk score and
a market where holders can insure against that issuer depegging, freezing
withdrawals, or failing.

Status: RiskOracle, Staking, Treasury and EventRegistry are implemented,
tested and merged; Governor, MarketFactory, Series and the price/FX
adapters remain stubs. See `technical-doc.md` for the full engineering
specification, and "Testnet deployment" below for a live deployment of
the four merged contracts.

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

RiskOracle, Staking, Treasury and EventRegistry are implemented, with full
unit, property, integration and budget test coverage. Governor,
MarketFactory, Series and the AMM/FX adapters still build as stubs
(`todo!()` bodies). The shared types in `contracts/types` match the spec
and have encoding tests. See `technical-doc.md` Section 1.2 for what's in
and out of scope for v1.

## Testnet deployment

A live deployment of the four merged contracts (RiskOracle, Staking,
Treasury, EventRegistry) to Stellar testnet, wired to each other, with
one real asset registered and scored. Governor and MarketFactory don't
exist yet, so two stand-ins are used; both are testnet-only, never
reused on mainnet, and get replaced the moment the real contracts land.

- **The admin key stands in for Governor.** A dedicated, funded testnet
  identity (`sylox-testnet-admin`) is passed wherever a contract
  expects a `governor` address. It holds no real value.
- **TUSD is test-only collateral, not real money.** An active keeper
  needs a bond the Circle testnet USDC faucet can't supply at the
  needed scale, so testnet uses a self-issued asset, "TUSD", deployed
  as its own Soroban Asset Contract. It is never called USDC anywhere
  in this deployment; the asset Sylox actually tracks and scores is
  separate, real Circle testnet USDC.
- **Demo signals are synthetic.** Nothing posts real signals until a
  keeper service exists (known gap, issue
  [#20](https://github.com/Sylox-labs/sylox/issues/20) and
  [#24](https://github.com/Sylox-labs/sylox/issues/24)), so
  `deploy/post-demo-signals.sh` has the testnet keeper post invented,
  plausible-looking data instead. Treat every score and band read from
  this deployment as a demonstration, not a real risk assessment.

Requires the `stellar` CLI pinned in `.github/workflows/ci.yml`
(`STELLAR_CLI_VERSION`) and `jq`.

```sh
# Deploy all four contracts, issue TUSD, register the tracked asset,
# write deployments/testnet.json. Safe to re-run: testnet is wiped
# periodically, and every run deploys fresh contract instances.
deploy/deploy.sh testnet

# Post synthetic demo signals for the last 24 closed epochs (or pass a
# different count), so RiskOracle has something to score.
deploy/post-demo-signals.sh testnet [epochs]

# Verify the deployment: every contract responds, the keeper is
# active, the reward bucket is funded, the tracked asset is
# registered, a fresh signal posts and reads back, and a non-admin
# call to a governor-gated function is rejected.
deploy/smoke-testnet.sh
```

The current deployment's contract ids, Wasm hashes, and identity
public keys are recorded in
[`deployments/testnet.json`](./deployments/testnet.json), rewritten on
every `deploy.sh testnet` run. No secret key ever appears in that file
or anywhere else in this repository; every identity's secret lives
only in the local `stellar keys` store.

Known gaps specific to this deployment: `initialize` is unauthenticated
and can be front-run on all four contracts (issue
[#21](https://github.com/Sylox-labs/sylox/issues/21)); committee-gated
functions (`rule`, `resolve_timeout`, signal dispute resolution) don't
work until Governor exists (issue
[#22](https://github.com/Sylox-labs/sylox/issues/22)); EventRegistry's
`factory` argument is a placeholder until MarketFactory exists (issue
[#23](https://github.com/Sylox-labs/sylox/issues/23)).

## Building

Requires Rust with the `wasm32v1-none` target and the Stellar CLI.

```sh
cargo check --workspace
cargo test --workspace
cargo build --target wasm32v1-none --release
```

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
