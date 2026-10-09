#!/usr/bin/env bash
# Reads deployments/testnet.json and checks the live deployment it
# describes. Every check prints PASS or FAIL; exits non-zero if any
# check fails.
#
# Usage: deploy/smoke-testnet.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RECORD="$REPO_ROOT/deployments/testnet.json"
STELLAR_BIN="${STELLAR_CLI_BIN:-stellar}"

if [[ ! -f "$RECORD" ]]; then
  echo "FATAL: $RECORD not found; run deploy/deploy.sh testnet first" >&2
  exit 1
fi

RO_ID="$(jq -r '.contracts.risk_oracle.id' "$RECORD")"
ST_ID="$(jq -r '.contracts.staking.id' "$RECORD")"
TR_ID="$(jq -r '.contracts.treasury.id' "$RECORD")"
ER_ID="$(jq -r '.contracts.event_registry.id' "$RECORD")"
TUSD_ID="$(jq -r '.tusd.contract_id' "$RECORD")"
ADMIN_ADDR="$(jq -r '.identities.admin' "$RECORD")"
KEEPER_ADDR="$(jq -r '.identities.keeper' "$RECORD")"
ASSET_ID="$(jq -r '.tracked_asset.contract_id' "$RECORD")"

FAILED=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILED=1; }

invoke_view() {
  "$STELLAR_BIN" contract invoke --id "$1" --source-account "$ADMIN_ADDR" --network testnet --send=no -- "${@:2}" 2>&1
}

# -- Reads --

for pair in "RiskOracle:$RO_ID" "Staking:$ST_ID" "Treasury:$TR_ID" "EventRegistry:$ER_ID" "TUSD:$TUSD_ID"; do
  label="${pair%%:*}"
  id="${pair#*:}"
  if [[ "$id" =~ ^C[A-Z0-9]{55}$ ]]; then
    pass "$label contract id looks well-formed ($id)"
  else
    fail "$label contract id malformed: $id"
  fi
done

out="$(invoke_view "$ST_ID" is_active_keeper --keeper "$KEEPER_ADDR")"
if [[ "$out" == "true" ]]; then
  pass "Staking.is_active_keeper(keeper) == true"
else
  fail "Staking.is_active_keeper(keeper) == $out, expected true"
fi

out="$(invoke_view "$TR_ID" balance --bucket '"KeeperRewards"')"
out_num="${out//\"/}"
if [[ "$out_num" =~ ^[0-9]+$ ]] && (( out_num > 0 )); then
  pass "Treasury KeeperRewards bucket balance is $out_num (> 0)"
else
  fail "Treasury KeeperRewards bucket balance is $out, expected a positive amount"
fi

out="$(invoke_view "$RO_ID" assets)"
if [[ "$out" == *"$ASSET_ID"* ]]; then
  pass "RiskOracle.assets() includes the tracked asset"
else
  fail "RiskOracle.assets() does not include $ASSET_ID: $out"
fi

out="$(invoke_view "$RO_ID" newest_epoch --asset "$ASSET_ID")"
if [[ "$out" != "null" && -n "$out" ]]; then
  pass "RiskOracle.newest_epoch(asset) is Some ($out)"
else
  fail "RiskOracle.newest_epoch(asset) is $out, expected Some; run deploy/post-demo-signals.sh testnet first"
fi

out="$(invoke_view "$ER_ID" current_version --asset "$ASSET_ID" --kind '"Depeg"')"
if [[ "$out" == "1" ]]; then
  pass "EventRegistry.current_version(asset, Depeg) == 1"
else
  fail "EventRegistry.current_version(asset, Depeg) == $out, expected 1"
fi

out="$(invoke_view "$ER_ID" cover_gate --asset "$ASSET_ID")"
if [[ $? -eq 0 && -n "$out" ]]; then
  pass "EventRegistry.cover_gate(asset) returned without error ($out)"
else
  fail "EventRegistry.cover_gate(asset) failed: $out"
fi

out="$(invoke_view "$ER_ID" active_event_count --asset "$ASSET_ID")"
if [[ "$out" == "0" ]]; then
  pass "EventRegistry.active_event_count(asset) == 0"
else
  fail "EventRegistry.active_event_count(asset) == $out, expected 0"
fi

# -- Write: post one fresh epoch, confirm it becomes the newest --

NOW="$(date +%s)"
EPOCH_SECS=3600
FRESH_EPOCH=$(( NOW / EPOCH_SECS - 1 ))
inputs_json=$(jq -nc --arg epoch "$FRESH_EPOCH" '{epoch: ($epoch|tonumber), smoke_test: true}')
inputs_hash="$(printf '%s' "$inputs_json" | shasum -a 256 | cut -d' ' -f1)"
signal_set="{\"epoch\":$FRESH_EPOCH,\"posted_at\":0,\"peg_ratio\":\"10000000\",\"peg_ratio_p10\":\"9990000\",\"liquidity_2pct\":\"500000000000\",\"redemption_net\":\"0\",\"supply\":\"10000000000000\",\"supply_change_bps\":0,\"issuer_actions\":{\"clawbacks\":0,\"clawback_amount\":\"0\",\"auth_revocations\":0,\"flag_changes\":0},\"endpoint\":\"Unknown\",\"inputs_hash\":\"$inputs_hash\",\"poster\":\"$KEEPER_ADDR\"}"

post_out="$("$STELLAR_BIN" contract invoke --id "$RO_ID" --source-account sylox-testnet-keeper --network testnet -- \
  post_signals --keeper "$KEEPER_ADDR" --asset "$ASSET_ID" --s "$signal_set" 2>&1)"
if [[ $? -ne 0 ]]; then
  fail "post_signals for a fresh epoch failed: $post_out"
else
  out="$(invoke_view "$RO_ID" newest_epoch --asset "$ASSET_ID")"
  if [[ "$out" == "$FRESH_EPOCH" ]]; then
    pass "a freshly posted epoch ($FRESH_EPOCH) appears as newest_epoch"
  else
    fail "posted epoch $FRESH_EPOCH but newest_epoch reports $out"
  fi
fi

# -- Negative: a non-admin address calling add_asset must be rejected --

# Auth is checked before anything else in add_asset, so the asset
# config's own content doesn't matter here; reuse the real tracked
# asset and issuer so this test depends on nothing but the identities
# the deployment record already names.
ISSUER_ADDR_FOR_NEGATIVE_TEST="$(jq -r '.tusd.issuer' "$RECORD")"
fake_cfg="{\"asset\":\"$ASSET_ID\",\"issuer\":\"$ISSUER_ADDR_FOR_NEGATIVE_TEST\",\"reference\":\"Usd\",\"home_domain\":\"example.com\",\"amm_adapters\":[],\"fx_adapter\":null,\"min_liquidity\":\"1\",\"issuer_flags\":{\"auth_revocable\":false,\"clawback_enabled\":false},\"enabled\":true}"
reject_out="$("$STELLAR_BIN" contract invoke --id "$RO_ID" --source-account sylox-testnet-keeper --network testnet -- add_asset --cfg "$fake_cfg" 2>&1)"
if [[ $? -ne 0 ]]; then
  pass "RiskOracle.add_asset from a non-admin (keeper) address is rejected"
else
  fail "RiskOracle.add_asset from a non-admin address SUCCEEDED (auth is not wired to the admin key): $reject_out"
fi

echo
if [[ "$FAILED" -eq 0 ]]; then
  echo "All smoke checks passed."
  exit 0
else
  echo "One or more smoke checks FAILED."
  exit 1
fi
