#!/usr/bin/env bash
# Anchorline deployment script. technical-doc.md Section 22.2.
#
# Usage: deploy/deploy.sh <testnet|mainnet>
#
# Mirrors the deployment order from the technical doc:
#   1. Build all contracts, optimize the Wasm.
#   2. Upload the Series Wasm, record its hash.
#   3. Deploy and initialize Governor (signers, threshold, timelocks, committee).
#   4. Deploy and initialize Staking, Treasury, RiskOracle, EventRegistry,
#      MarketFactory (with the Series Wasm hash); wire addresses together
#      (addresses are precomputed, so mutual references go to initialize).
#   5. Through governor actions: add keepers and reporters (on Staking),
#      assets, one canonical event definition per (asset, kind); set
#      parameters from deploy/<network>.toml.
#   6. Start keeper, reporter nodes, indexer and API; wait for
#      stale_after_epochs clean epochs.
#   7. Through governor: open the first series.
#   8. Publish all contract ids and Wasm hashes to deployments/<network>.json.
#
# This is a skeleton: each step is a placeholder until the corresponding
# contract (Section 12) is implemented. Steps 3-4 require `stellar contract
# deploy` and `invoke` calls against the built Wasm in target/wasm32v1-none.

set -euo pipefail

NETWORK="${1:-}"
if [[ "$NETWORK" != "testnet" && "$NETWORK" != "mainnet" ]]; then
  echo "usage: $0 <testnet|mainnet>" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$REPO_ROOT/deploy/$NETWORK.toml"
DEPLOYMENTS_DIR="$REPO_ROOT/deployments"

echo "==> Anchorline deploy: $NETWORK"
echo "==> Config: $CONFIG"

echo "==> [1/8] Building contracts"
(cd "$REPO_ROOT" && cargo build --target wasm32v1-none --release)
echo "TODO: stellar contract optimize on each built .wasm"

echo "==> [2/8] Upload Series Wasm"
echo "TODO: stellar contract upload --wasm contracts/series/...wasm, record hash"

echo "==> [3/8] Deploy and initialize Governor"
echo "TODO: stellar contract deploy + invoke initialize(signers, threshold, timelock_secs, committee)"

echo "==> [4/8] Deploy and initialize Staking, Treasury, RiskOracle, EventRegistry, MarketFactory"
echo "TODO: deploy each; wire addresses per Section 3.1"

echo "==> [5/8] Apply governor actions from $CONFIG"
echo "TODO: queue/approve/execute AddKeeper, AddReporter, AddAsset, RegisterDefinition, SetParam"

echo "==> [6/8] Start offchain services"
echo "TODO: start services/keeper, services/reporter-node, services/indexer, services/api"
echo "TODO: wait for stale_after_epochs clean epochs before opening series"

echo "==> [7/8] Open first series"
echo "TODO: governor action OpenSeries(SeriesTerms)"

echo "==> [8/8] Publish deployment record"
mkdir -p "$DEPLOYMENTS_DIR"
echo "TODO: write $DEPLOYMENTS_DIR/$NETWORK.json with contract ids and Wasm hashes"

echo "==> Done (skeleton run; see TODOs above)"
