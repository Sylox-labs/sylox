#!/usr/bin/env bash
# Issues DEMOUSD, a sample-only Stellar classic asset with real
# auth-revocable and clawback-enabled issuer flags, registers it in
# RiskOracle, registers an IssuerFreeze EventDefinition for it, and
# writes deployments/testnet-demo-asset.json.
#
# This is a SAMPLE asset for demonstrating a real, on-chain-triggered
# IssuerFreeze event. It is never DEMOUSD:anyone-but-this-script's-own-
# issuer, never a real stablecoin, and never confused with TUSD
# (collateral, deploy.sh, lead decision D2) or the tracked USDC asset
# (D3). Do not mint, hold, or transact real value with it.
#
# Usage: deploy/demo-asset.sh testnet
#
# Safe to run twice: every step checks whether it already happened
# (the issuer identity, the SAC deploy, the flags, the asset
# registration, the definition registration) and skips what's already
# done, the same convention deploy.sh itself uses for TUSD.
#
# Does NOT post history or trigger the freeze; see
# deploy/demo-asset-trigger.sh for that, run separately once this
# script's own output confirms DEMOUSD is registered and ready.

set -uo pipefail

NETWORK="${1:-}"
if [[ "$NETWORK" != "testnet" ]]; then
  echo "usage: $0 testnet" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RECORD="$REPO_ROOT/deployments/testnet.json"
DEMO_RECORD="$REPO_ROOT/deployments/testnet-demo-asset.json"
[[ -f "$RECORD" ]] || { echo "FATAL: $RECORD not found; run deploy/deploy.sh testnet first" >&2; exit 1; }

STELLAR_BIN="${STELLAR_CLI_BIN:-stellar}"
RO_ID="$(jq -r '.contracts.risk_oracle.id' "$RECORD")"
ER_ID="$(jq -r '.contracts.event_registry.id' "$RECORD")"
ADMIN=sylox-testnet-admin   # Identity alias (signing key), not the bare address: deploy.sh's own convention.
ADMIN_ADDR="$(jq -r '.identities.admin' "$RECORD")"

DEMO_CODE="DEMOUSD"
ISSUER=sylox-demo-issuer   # NEVER the admin, keeper, or TUSD issuer.

log() { echo "==> $*"; }
die() { echo "FATAL: $*" >&2; exit 1; }

# -- [1/5] Identity --------------------------------------------------

log "[1/5] DEMOUSD issuer identity"
if "$STELLAR_BIN" keys address "$ISSUER" >/dev/null 2>&1; then
  log "identity $ISSUER already exists"
else
  "$STELLAR_BIN" keys generate "$ISSUER" --network testnet --fund
  log "identity $ISSUER created and funded"
fi
ISSUER_ADDR="$("$STELLAR_BIN" keys address "$ISSUER")"

# -- [2/5] Issuer flags, BEFORE issuing anything ---------------------
#
# Clawback only applies to trustlines created AFTER the issuer's own
# CLAWBACK_ENABLED flag is set (Stellar protocol rule, not a Sylox
# one): setting flags first, before any holder ever creates a
# trustline to DEMOUSD, is what makes a real clawback possible later
# at all. Checked by reading the issuer account's current flags
# first, so a second run doesn't resubmit a transaction that would
# only reconfirm flags already set.

log "[2/5] Setting AUTH_REVOCABLE and CLAWBACK_ENABLED on $ISSUER_ADDR"
account_json="$(curl -sSf "https://horizon-testnet.stellar.org/accounts/$ISSUER_ADDR" 2>&1)" || die "could not read issuer account from Horizon: $account_json"
has_revocable="$(echo "$account_json" | jq -r '.flags.auth_revocable // false')"
has_clawback="$(echo "$account_json" | jq -r '.flags.auth_clawback_enabled // false')"

if [[ "$has_revocable" == "true" && "$has_clawback" == "true" ]]; then
  log "issuer flags already set (auth_revocable, clawback_enabled)"
else
  if ! flags_out="$("$STELLAR_BIN" tx new set-options --source-account "$ISSUER" --network testnet \
    --set-revocable --set-clawback-enabled 2>&1)"; then
    die "setting issuer flags failed:
$flags_out"
  fi
  echo "$flags_out"
  log "issuer flags set: auth_revocable, clawback_enabled"
fi

# -- [3/5] Deploy the SAC ---------------------------------------------
#
# Same derived-address convention as TUSD (deploy.sh, lead decision
# D2): the SAC's contract id is deterministic from asset code + issuer,
# so a second run's "already exists" on deploy is expected, not fatal.

log "[3/5] Deploying DEMOUSD's Stellar Asset Contract"
DEMO_ID="$("$STELLAR_BIN" contract id asset --asset "$DEMO_CODE:$ISSUER_ADDR" --network testnet)"
if deploy_out="$("$STELLAR_BIN" contract asset deploy --asset "$DEMO_CODE:$ISSUER_ADDR" \
     --source-account "$ISSUER" --network testnet 2>&1)"; then
  log "DEMOUSD contract deployed: $DEMO_ID"
elif echo "$deploy_out" | grep -qi "already exists\|ExistingValue"; then
  log "DEMOUSD contract already exists at the derived address: $DEMO_ID"
else
  die "DEMOUSD deploy failed:
$deploy_out"
fi

# -- [4/5] Register in RiskOracle, flags matching the REAL on-chain ones --

log "[4/5] RiskOracle.add_asset"
existing_assets="$("$STELLAR_BIN" contract invoke --id "$RO_ID" --source-account "$ADMIN_ADDR" --network testnet --send=no -- assets)"
if [[ "$existing_assets" == *"$DEMO_ID"* ]]; then
  log "RiskOracle already has DEMOUSD registered"
else
  demo_cfg="{\"asset\":\"$DEMO_ID\",\"issuer\":\"$ISSUER_ADDR\",\"reference\":\"Usd\",\"home_domain\":\"example-demo.sylox.test\",\"amm_adapters\":[],\"fx_adapter\":null,\"min_liquidity\":\"1\",\"issuer_flags\":{\"auth_revocable\":true,\"clawback_enabled\":true},\"enabled\":true}"
  if ! add_out="$("$STELLAR_BIN" contract invoke --id "$RO_ID" --source-account "$ADMIN" --network testnet -- add_asset --cfg "$demo_cfg" 2>&1)"; then
    die "RiskOracle.add_asset(DEMOUSD) failed:
$add_out"
  fi
  log "RiskOracle.add_asset: $DEMO_ID registered (issuer_flags: auth_revocable=true, clawback_enabled=true, matching the real on-chain flags set in step 2)"
fi

# -- [5/5] Register the IssuerFreeze definition -----------------------
#
# technical-doc.md Section 8.2: IssuerFreeze triggers over the 7 days
# ending at the latest Final epoch if clawback_amount/supply >=
# freeze_pct_bps OR auth_revocations > auth_revocation_threshold.
# freeze_pct_bps = 100 (1%) and auth_revocation_threshold = 0 (so even
# a single revocation, if posted, is already enough on its own) are
# deliberately low: this is a demo asset meant to prove the trigger
# fires at all, not a realistic production threshold.
#
# challenge_secs = 3600 (1 hour, CHALLENGE_SECS_MIN_EPOCHS, the
# shortest allowed) is deliberate and DEMOUSD-only: a demo event needs
# `finalize` reachable quickly, not the 24h challenge window USDC's
# own Depeg definition uses. Never change USDC's definitions to match;
# this short window exists so a demo can be walked through in an hour,
# not because it reflects a real challenge period.

log "[5/5] EventRegistry.register_definition (IssuerFreeze, challenge_secs=3600)"
current_version="$("$STELLAR_BIN" contract invoke --id "$ER_ID" --source-account "$ADMIN_ADDR" --network testnet --send=no -- current_version --asset "$DEMO_ID" --kind '"IssuerFreeze"' 2>&1)"
needs_registration=1
if [[ "$current_version" =~ ^[1-9][0-9]*$ ]]; then
  existing_def="$("$STELLAR_BIN" contract invoke --id "$ER_ID" --source-account "$ADMIN_ADDR" --network testnet --send=no -- definition --asset "$DEMO_ID" --kind '"IssuerFreeze"' --version "$current_version" 2>&1)"
  existing_challenge_secs="$(echo "$existing_def" | jq -r '.challenge_secs // empty' 2>/dev/null)"
  if [[ "$existing_challenge_secs" == "3600" ]]; then
    log "IssuerFreeze definition already registered for DEMOUSD at challenge_secs=3600 (version $current_version)"
    needs_registration=0
  else
    log "IssuerFreeze version $current_version exists at challenge_secs=${existing_challenge_secs:-unknown}, not 3600; registering a new canonical version"
  fi
fi
if (( needs_registration )); then
  demo_def="{\"asset\":\"$DEMO_ID\",\"kind\":\"IssuerFreeze\",\"version\":0,\"reference\":\"Usd\",\"depeg_threshold\":\"0\",\"depeg_window_secs\":0,\"max_missing_epochs\":0,\"cure_threshold\":\"0\",\"freeze_pct_bps\":100,\"auth_revocation_threshold\":0,\"mint_spike_bps\":0,\"halt_window_secs\":0,\"challenge_secs\":3600,\"ruling_deadline_secs\":1209600}"
  if ! def_out="$("$STELLAR_BIN" contract invoke --id "$ER_ID" --source-account "$ADMIN" --network testnet -- register_definition --def "$demo_def" 2>&1)"; then
    die "register_definition(DEMOUSD, IssuerFreeze) failed:
$def_out"
  fi
  log "EventRegistry.register_definition: IssuerFreeze registered for DEMOUSD (freeze_pct_bps=100, auth_revocation_threshold=0, challenge_secs=3600)"
fi

cat > "$DEMO_RECORD" <<EOF
{
  "network": "testnet",
  "demo_asset": {
    "contract_id": "$DEMO_ID",
    "asset_code": "$DEMO_CODE",
    "issuer": "$ISSUER_ADDR",
    "note": "SAMPLE asset only, auth_revocable + clawback_enabled, never real value. Never call this a real stablecoin."
  }
}
EOF
log "demo asset record written: $DEMO_RECORD"
log "Done. Next: deploy/demo-asset-trigger.sh testnet to create a holder, post DEMOUSD's own history, and trigger a real freeze."
