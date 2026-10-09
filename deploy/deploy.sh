#!/usr/bin/env bash
# Sylox testnet deployment script.
#
# Usage: deploy/deploy.sh testnet
#
# Deploys and wires the four merged contracts (RiskOracle, Staking,
# Treasury, EventRegistry), issues a test-only collateral token (TUSD,
# see D2 below), registers one real tracked asset (D3), and writes a
# fresh deployments/testnet.json record every run.
#
# `deploy/deploy.sh mainnet` is not implemented: mainnet needs Governor
# and MarketFactory deployed first (neither is merged yet), a real
# collateral token (no TUSD stand-in), and atomic constructor-based
# initialize (known-gap: initialize is unauthenticated on all four
# contracts today). Wiring that up before those land would be building
# on sand.
#
# Lead decisions, not reopened here:
#   D1. `sylox-testnet-admin` stands in for Governor everywhere a
#       contract's `initialize` expects a `governor` address.
#   D2. Testnet collateral is a self-issued asset, "TUSD", issued by
#       `sylox-testnet-issuer`, deployed as a Soroban Asset Contract.
#       Never called USDC anywhere, so nobody confuses it with real
#       money.
#   D3. The asset Sylox scores is real Circle testnet USDC
#       (USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5),
#       looked up via `stellar contract id asset`, never hardcoded.
#   D4. EventRegistry's `factory` argument has no reader anywhere in
#       EventRegistry today (`config.factory` is stored, never read;
#       `version_has_live_cover` is stubbed to always return `false`
#       without touching it) — confirmed by reading
#       contracts/event-registry/src/lib.rs before writing this
#       script. `sylox-testnet-admin` is passed as a placeholder.
#
# Identities (created only if they don't already exist, then funded
# via Friendbot): sylox-testnet-deployer, sylox-testnet-admin,
# sylox-testnet-issuer, sylox-testnet-keeper. Secret keys live only in
# the local `stellar keys` store; this script never prints or writes
# one anywhere.

set -euo pipefail

NETWORK="${1:-}"
if [[ "$NETWORK" != "testnet" && "$NETWORK" != "mainnet" ]]; then
  echo "usage: $0 <testnet|mainnet>" >&2
  exit 1
fi

if [[ "$NETWORK" == "mainnet" ]]; then
  echo "deploy/deploy.sh mainnet is not implemented yet: mainnet needs Governor" >&2
  echo "and MarketFactory deployed first, plus atomic constructor-based" >&2
  echo "initialize (see known-gap: initialize can be front-run on all four" >&2
  echo "contracts today). See this script's own header comment." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOYMENTS_DIR="$REPO_ROOT/deployments"
RECORD="$DEPLOYMENTS_DIR/testnet.json"

# Pinned to the same stellar-cli version .github/workflows/ci.yml
# builds and verifies against (hard rule 4). STELLAR_CLI_BIN may
# override the binary path (e.g. in CI, where it's on PATH already);
# otherwise this script expects it on PATH.
REQUIRED_STELLAR_VERSION="28.1.0"
STELLAR_BIN="${STELLAR_CLI_BIN:-stellar}"

RPC_URL="https://soroban-testnet.stellar.org"
PASSPHRASE="Test SDF Network ; September 2015"

DEPLOYER=sylox-testnet-deployer
ADMIN=sylox-testnet-admin
ISSUER=sylox-testnet-issuer
KEEPER=sylox-testnet-keeper

TUSD_CODE="TUSD"
USDC_CLASSIC_ASSET="USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"

KEEPER_BOND=50000000000       # params::KEEPER_BOND, 5,000 TUSD at 7 decimals
KEEPER_REWARD_FUNDING=10000000000  # 1,000 TUSD at 7 decimals

log() { echo "==> $*"; }
die() { echo "FATAL: $*" >&2; exit 1; }

# -- [1/7] Preflight --------------------------------------------------

log "[1/7] Preflight"

got_version="$("$STELLAR_BIN" --version | head -1 | awk '{print $2}')"
if [[ "$got_version" != "$REQUIRED_STELLAR_VERSION" ]]; then
  die "stellar CLI version mismatch: need $REQUIRED_STELLAR_VERSION (CI's pinned version), found $got_version. Set STELLAR_CLI_BIN to the pinned binary."
fi
log "stellar CLI: $got_version (matches CI's pin)"

if ! curl -sSf -X POST "$RPC_URL" -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' >/dev/null; then
  die "testnet RPC ($RPC_URL) is not reachable"
fi
log "RPC reachable: $RPC_URL"

if [[ -n "$(cd "$REPO_ROOT" && git status --porcelain --untracked-files=no)" ]]; then
  die "working tree has uncommitted changes to tracked files; commit or stash before deploying (every run must be reproducible from a clean, known commit). Untracked files are not checked: this repo carries unrelated untracked files that are not this script's concern."
fi
GIT_COMMIT="$(cd "$REPO_ROOT" && git rev-parse HEAD)"
log "git commit: $GIT_COMMIT"

# -- [2/7] Build -------------------------------------------------------

log "[2/7] Building contracts"
(cd "$REPO_ROOT" && "$STELLAR_BIN" contract build)

WASM_DIR="$REPO_ROOT/target/wasm32v1-none/release"
declare -A WASM_FILE=(
  [risk_oracle]="$WASM_DIR/risk_oracle.wasm"
  [staking]="$WASM_DIR/staking.wasm"
  [treasury]="$WASM_DIR/treasury.wasm"
  [event_registry]="$WASM_DIR/event_registry.wasm"
)
declare -A WASM_SIZE
declare -A WASM_HASH
for name in risk_oracle staking treasury event_registry; do
  f="${WASM_FILE[$name]}"
  [[ -f "$f" ]] || die "expected Wasm not found: $f"
  WASM_SIZE[$name]="$(wc -c < "$f" | tr -d ' ')"
  WASM_HASH[$name]="$(shasum -a 256 "$f" | cut -d' ' -f1)"
  log "$name.wasm: ${WASM_SIZE[$name]} bytes, sha256 ${WASM_HASH[$name]}"
done

# -- [3/7] Identities ---------------------------------------------------

log "[3/7] Identities"

ensure_identity() {
  local name="$1"
  if "$STELLAR_BIN" keys address "$name" >/dev/null 2>&1; then
    log "identity $name already exists"
  else
    "$STELLAR_BIN" keys generate "$name" --network testnet --fund
    log "identity $name created and funded"
  fi
}
for id in "$DEPLOYER" "$ADMIN" "$ISSUER" "$KEEPER"; do
  ensure_identity "$id"
done

ADMIN_ADDR="$("$STELLAR_BIN" keys address "$ADMIN")"
ISSUER_ADDR="$("$STELLAR_BIN" keys address "$ISSUER")"
KEEPER_ADDR="$("$STELLAR_BIN" keys address "$KEEPER")"
DEPLOYER_ADDR="$("$STELLAR_BIN" keys address "$DEPLOYER")"

# -- [4/7] TUSD (D2) -----------------------------------------------------

log "[4/7] TUSD test collateral"

TUSD_ID="$("$STELLAR_BIN" contract asset deploy --asset "$TUSD_CODE:$ISSUER_ADDR" \
  --source-account "$DEPLOYER" --network testnet 2>&1 | tail -1)"
[[ "$TUSD_ID" =~ ^C[A-Z0-9]{55}$ ]] || die "unexpected TUSD deploy output: $TUSD_ID"
log "TUSD contract: $TUSD_ID"

ensure_trustline() {
  local holder="$1"
  "$STELLAR_BIN" tx new change-trust --source-account "$holder" \
    --line "$TUSD_CODE:$ISSUER_ADDR" --network testnet >/dev/null
}
ensure_trustline "$ADMIN"
ensure_trustline "$KEEPER"

mint_tusd() {
  local to_addr="$1" amount="$2"
  "$STELLAR_BIN" contract invoke --id "$TUSD_ID" --source-account "$ISSUER" \
    --network testnet -- mint --to "$to_addr" --amount "$amount" >/dev/null
}
mint_tusd "$KEEPER_ADDR" "$KEEPER_BOND"
mint_tusd "$ADMIN_ADDR" "$KEEPER_REWARD_FUNDING"
log "minted $KEEPER_BOND TUSD to keeper, $KEEPER_REWARD_FUNDING TUSD to admin"

# -- [5/7] Deploy the four contracts (not yet initialized) --------------

log "[5/7] Deploying contracts"

deploy_contract() {
  local name="$1"
  "$STELLAR_BIN" contract deploy --wasm "${WASM_FILE[$name]}" \
    --source-account "$DEPLOYER" --network testnet 2>&1 | tail -1
}
RO_ID="$(deploy_contract risk_oracle)"
ST_ID="$(deploy_contract staking)"
TR_ID="$(deploy_contract treasury)"
ER_ID="$(deploy_contract event_registry)"
for v in RO_ID ST_ID TR_ID ER_ID; do
  [[ "${!v}" =~ ^C[A-Z0-9]{55}$ ]] || die "unexpected deploy output for $v: ${!v}"
done
log "RiskOracle:    $RO_ID"
log "Staking:       $ST_ID"
log "Treasury:      $TR_ID"
log "EventRegistry: $ER_ID"

# -- [6/7] Initialize, wired together, abort loudly on front-run --------

log "[6/7] Initializing (front-run check: AlreadyInitialized aborts the run)"

invoke() {
  local contract="$1" source="$2"; shift 2
  "$STELLAR_BIN" contract invoke --id "$contract" --source-account "$source" --network testnet -- "$@"
}

run_init() {
  local label="$1"; shift
  local out
  if ! out="$("$@" 2>&1)"; then
    if echo "$out" >&2 && echo "$out" | grep -qi "AlreadyInitialized\|Error(Contract, #1)"; then
      die "$label: already initialized by someone else (front-run). Aborting the whole run; do not continue on a contract someone else initialized. Redeploy from scratch with fresh contract ids."
    fi
    die "$label: initialize failed:
$out"
  fi
  log "$label initialized"
}

run_init "RiskOracle" invoke "$RO_ID" "$DEPLOYER" initialize \
  --governor "$ADMIN_ADDR" --registry "$ER_ID" --staking "$ST_ID"

run_init "Staking" invoke "$ST_ID" "$DEPLOYER" initialize \
  --governor "$ADMIN_ADDR" --oracle "$RO_ID" --registry "$ER_ID" --treasury "$TR_ID" --usdc "$TUSD_ID"

run_init "Treasury" invoke "$TR_ID" "$DEPLOYER" initialize \
  --governor "$ADMIN_ADDR" --staking "$ST_ID" --usdc "$TUSD_ID"

run_init "EventRegistry" invoke "$ER_ID" "$DEPLOYER" initialize \
  --governor "$ADMIN_ADDR" --oracle "$RO_ID" --staking "$ST_ID" --factory "$ADMIN_ADDR" --usdc "$TUSD_ID"

# -- [7/7] Protocol setup -------------------------------------------------

log "[7/7] Protocol setup"

invoke "$ST_ID" "$ADMIN" add_keeper --keeper "$KEEPER_ADDR" >/dev/null
log "keeper added"

invoke "$ST_ID" "$KEEPER" stake --who "$KEEPER_ADDR" --amount "$KEEPER_BOND" >/dev/null
is_active="$("$STELLAR_BIN" contract invoke --id "$ST_ID" --source-account "$ADMIN" --network testnet --send=no -- is_active_keeper --keeper "$KEEPER_ADDR")"
[[ "$is_active" == "true" ]] || die "keeper staked but is_active_keeper reports $is_active, not true"
log "keeper staked $KEEPER_BOND, is_active_keeper: true"

invoke "$TR_ID" "$ADMIN" deposit --from "$ADMIN_ADDR" --bucket '"KeeperRewards"' --amount "$KEEPER_REWARD_FUNDING" >/dev/null
reward_balance="$("$STELLAR_BIN" contract invoke --id "$TR_ID" --source-account "$ADMIN" --network testnet --send=no -- balance --bucket '"KeeperRewards"')"
log "KeeperRewards bucket funded: $reward_balance"

TRACKED_ASSET_ID="$("$STELLAR_BIN" contract id asset --asset "$USDC_CLASSIC_ASSET" --network testnet)"
log "tracked asset (D3) contract id: $TRACKED_ASSET_ID"

USDC_ISSUER="${USDC_CLASSIC_ASSET#*:}"
ASSET_CFG="{\"asset\":\"$TRACKED_ASSET_ID\",\"issuer\":\"$USDC_ISSUER\",\"reference\":\"Usd\",\"home_domain\":\"centre.io\",\"amm_adapters\":[],\"fx_adapter\":null,\"min_liquidity\":\"100000000000\",\"issuer_flags\":{\"auth_revocable\":false,\"clawback_enabled\":false},\"enabled\":true}"
invoke "$RO_ID" "$ADMIN" add_asset --cfg "$ASSET_CFG" >/dev/null
log "RiskOracle.add_asset: $TRACKED_ASSET_ID registered"

# technical-doc.md Section 23 defaults.
DEPEG_DEF="{\"asset\":\"$TRACKED_ASSET_ID\",\"kind\":\"Depeg\",\"version\":0,\"reference\":\"Usd\",\"depeg_threshold\":\"9500000\",\"depeg_window_secs\":259200,\"max_missing_epochs\":6,\"cure_threshold\":\"9800000\",\"freeze_pct_bps\":0,\"auth_revocation_threshold\":0,\"mint_spike_bps\":0,\"halt_window_secs\":0,\"challenge_secs\":86400,\"ruling_deadline_secs\":1209600}"
invoke "$ER_ID" "$ADMIN" register_definition --def "$DEPEG_DEF" >/dev/null
log "EventRegistry.register_definition: Depeg v1 registered for $TRACKED_ASSET_ID"

# -- Write the deployment record -----------------------------------------

mkdir -p "$DEPLOYMENTS_DIR"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat > "$RECORD" <<EOF
{
  "network": "testnet",
  "passphrase": "$PASSPHRASE",
  "rpc_url": "$RPC_URL",
  "deployed_at": "$TIMESTAMP",
  "git_commit": "$GIT_COMMIT",
  "stellar_cli_version": "$got_version",
  "contracts": {
    "risk_oracle": { "id": "$RO_ID", "wasm_hash": "${WASM_HASH[risk_oracle]}", "wasm_size": ${WASM_SIZE[risk_oracle]} },
    "staking": { "id": "$ST_ID", "wasm_hash": "${WASM_HASH[staking]}", "wasm_size": ${WASM_SIZE[staking]} },
    "treasury": { "id": "$TR_ID", "wasm_hash": "${WASM_HASH[treasury]}", "wasm_size": ${WASM_SIZE[treasury]} },
    "event_registry": { "id": "$ER_ID", "wasm_hash": "${WASM_HASH[event_registry]}", "wasm_size": ${WASM_SIZE[event_registry]} }
  },
  "tusd": {
    "contract_id": "$TUSD_ID",
    "asset_code": "$TUSD_CODE",
    "issuer": "$ISSUER_ADDR",
    "note": "Test-only collateral (lead decision D2). Never real money. Never call this USDC."
  },
  "tracked_asset": {
    "contract_id": "$TRACKED_ASSET_ID",
    "classic_asset": "$USDC_CLASSIC_ASSET",
    "note": "Real Circle testnet USDC (lead decision D3), separate from the TUSD collateral above."
  },
  "identities": {
    "deployer": "$DEPLOYER_ADDR",
    "admin": "$ADMIN_ADDR",
    "issuer": "$ISSUER_ADDR",
    "keeper": "$KEEPER_ADDR"
  }
}
EOF
log "deployment record written: $RECORD"

log "Done. Run deploy/smoke-testnet.sh to verify, deploy/post-demo-signals.sh testnet to post demo data."
