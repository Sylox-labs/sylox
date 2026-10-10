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

# Order matters (deploy/README.md): deploy/post-demo-signals.sh must
# run BEFORE this script, never after. Review finding (this session):
# the write check further below posts one epoch as a side effect when
# the asset has no history yet, which would otherwise become the
# asset's first-ever post. `FirstEpoch` is set once, from whichever
# epoch is posted first (storage::set_first_epoch_if_unset), and never
# moves after that; score()'s own 7 day history requirement counts
# forward from it (Section 6.5). Running this script first would
# silently anchor that 7 day clock to whatever the newest epoch
# happened to be at THIS moment, not to the oldest epoch the backfill
# is about to post, needlessly delaying when the asset starts scoring.
# Refuse outright rather than let that happen again.
first_epoch="$(stellar contract invoke --id "$RO_ID" --source-account "$ADMIN_ADDR" --network testnet --send=no -- first_epoch --asset "$ASSET_ID" 2>&1)"
if [[ "$first_epoch" != [0-9]* ]]; then
  echo "FATAL: $ASSET_ID has no posting history yet (first_epoch: $first_epoch)." >&2
  echo "Run deploy/post-demo-signals.sh testnet BEFORE this script, never after:" >&2
  echo "this script's own write check would otherwise become the asset's first" >&2
  echo "post and anchor its 7 day scoring clock to the wrong epoch. See" >&2
  echo "deploy/README.md." >&2
  exit 1
fi

FAILED=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILED=1; }

invoke_view() {
  "$STELLAR_BIN" contract invoke --id "$1" --source-account "$ADMIN_ADDR" --network testnet --send=no -- "${@:2}" 2>&1
}

# -- Reads --
#
# Every check below is a real call against the live contract, not a
# check that its id merely looks like a contract id: a dead or wrong
# address fails the call itself (confirmed against a syntactically
# valid but non-existent address: "contract not found", exit 1), so
# there's no separate liveness check needed on top of the value
# checks already here. TUSD has no other call anywhere in this
# script, so it gets one of its own.

out="$("$STELLAR_BIN" contract invoke --id "$TUSD_ID" --source-account "$ADMIN_ADDR" --network testnet --send=no -- decimals 2>&1)"
if [[ "$out" == "7" ]]; then
  pass "TUSD responds (decimals() == 7)"
else
  fail "TUSD.decimals() failed or returned an unexpected value, contract may be dead or misaddressed: $out"
fi

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
if [[ "$out" =~ ^[0-9]+$ ]]; then
  pass "RiskOracle.newest_epoch(asset) is Some ($out)"
else
  fail "RiskOracle.newest_epoch(asset) is not a number ($out), expected Some; run deploy/post-demo-signals.sh testnet first or check the contract is live"
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

# -- Write: post one not-yet-posted epoch via the hourly path, confirm
#    it reads back --
#
# "Post one fresh epoch and confirm it appears as the newest epoch" is
# straightforward only when the tracked asset isn't already caught up
# to the current hour. Right after deploy/post-demo-signals.sh, it
# usually is: the freshest closed epoch is already posted, and the
# next NEW one won't close for up to an hour, which would make this
# smoke test impractically slow to wait for. So: if there's a
# genuinely fresh (newer than newest_epoch, already closed) epoch
# available, post that one and confirm it becomes the newest, exactly
# as asked. Otherwise, scan backward for an epoch the HOURLY path can
# actually still accept.
#
# Review finding (this session): `signals(asset, epoch)` returning
# `null` is NOT the same thing as "the hourly path can post this
# epoch." Since v1.5 (Section 5.9), an hour whose sub-epochs were
# posted through post_sub_signals never writes RiskOracle's own
# Signals(asset, epoch) key at all (that only happens once build_hour
# rolls the hour up) — signals() legitimately reads null for an hour
# that is nonetheless already closed to the hourly path
# (HourPostedVia::SubEpoch), which post_signals's own mutual-exclusion
# guard rejects with HourAlreadyPosted (#115). Scanning by `signals()
# == null` alone picked exactly such an hour and failed here. Instead,
# ATTEMPT the hourly post on each candidate and treat
# EpochAlreadyPosted (#103) / HourAlreadyPosted (#115) as "try an
# older candidate," the only check that reflects post_signals's own
# real acceptance rule.

EPOCH_SECS=3600
current_newest="$(invoke_view "$RO_ID" newest_epoch --asset "$ASSET_ID")"
NOW="$(date +%s)"
freshest_closed=$(( NOW / EPOCH_SECS - 1 ))

try_post_hourly() {
  local epoch="$1"
  local inputs_json inputs_hash signal_set
  inputs_json=$(jq -nc --arg epoch "$epoch" '{epoch: ($epoch|tonumber), smoke_test: true}')
  inputs_hash="$(printf '%s' "$inputs_json" | shasum -a 256 | cut -d' ' -f1)"
  signal_set="{\"epoch\":$epoch,\"posted_at\":0,\"peg_ratio\":\"10000000\",\"peg_ratio_p10\":\"9990000\",\"liquidity_2pct\":\"500000000000\",\"redemption_net\":\"0\",\"supply\":\"10000000000000\",\"supply_change_bps\":0,\"issuer_actions\":{\"clawbacks\":0,\"clawback_amount\":\"0\",\"auth_revocations\":0,\"flag_changes\":0},\"endpoint\":\"Unknown\",\"inputs_hash\":\"$inputs_hash\",\"poster\":\"$KEEPER_ADDR\"}"
  "$STELLAR_BIN" contract invoke --id "$RO_ID" --source-account sylox-testnet-keeper --network testnet -- \
    post_signals --keeper "$KEEPER_ADDR" --asset "$ASSET_ID" --s "$signal_set" 2>&1
}
is_already_posted_error() {
  [[ "$1" == *"Error(Contract, #103)"* || "$1" == *"Error(Contract, #115)"* ]]
}

FRESH_EPOCH=""
EXPECT_NEWEST=0
POST_OUT=""
if [[ ! "$current_newest" =~ ^[0-9]+$ || "$current_newest" -lt "$freshest_closed" ]]; then
  if POST_OUT="$(try_post_hourly "$freshest_closed")"; then
    FRESH_EPOCH="$freshest_closed"
    EXPECT_NEWEST=1
  elif ! is_already_posted_error "$POST_OUT"; then
    fail "post_signals for epoch $freshest_closed failed: $POST_OUT"
  fi
fi
if [[ -z "$FRESH_EPOCH" && "$FAILED" -eq 0 ]]; then
  for (( candidate = freshest_closed; candidate > freshest_closed - 72; candidate-- )); do
    if POST_OUT="$(try_post_hourly "$candidate")"; then
      FRESH_EPOCH="$candidate"
      break
    elif ! is_already_posted_error "$POST_OUT"; then
      fail "post_signals for epoch $candidate failed: $POST_OUT"
      break
    fi
    # EpochAlreadyPosted/HourAlreadyPosted: try an older candidate.
  done
fi

if [[ -z "$FRESH_EPOCH" && "$FAILED" -eq 0 ]]; then
  fail "every epoch in the last 72h already rejects the hourly path (EpochAlreadyPosted/HourAlreadyPosted); cannot find one to test a write with"
elif [[ -n "$FRESH_EPOCH" ]]; then
  if (( EXPECT_NEWEST )); then
    out="$(invoke_view "$RO_ID" newest_epoch --asset "$ASSET_ID")"
    if [[ "$out" == "$FRESH_EPOCH" ]]; then
      pass "a freshly posted epoch ($FRESH_EPOCH) appears as newest_epoch"
    else
      fail "posted epoch $FRESH_EPOCH but newest_epoch reports $out"
    fi
  else
    out="$(invoke_view "$RO_ID" signals --asset "$ASSET_ID" --epoch "$FRESH_EPOCH")"
    if [[ "$out" == *"\"epoch\":$FRESH_EPOCH"* ]]; then
      pass "a freshly posted epoch ($FRESH_EPOCH, a backfilled gap since the asset was already caught up to now) reads back correctly"
    else
      fail "posted epoch $FRESH_EPOCH but signals(asset, $FRESH_EPOCH) does not reflect it: $out"
    fi
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
