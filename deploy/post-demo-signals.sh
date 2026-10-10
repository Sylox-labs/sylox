#!/usr/bin/env bash
# Posts plausible, SYNTHETIC signals for the last N closed epochs of
# the tracked asset, as the testnet keeper. Without this (or the
# keeper service, which doesn't exist yet — see known-gap, issue
# linked in the README), RiskOracle's score and band stay blank on a
# fresh testnet deploy: nothing has ever posted real data.
#
# These are NOT observations of the real USDC market. They are
# round-tripped demo values this script invents so RiskOracle has
# something to compute a score and band from. Do not treat any value
# this script posts as a genuine signal about USDC's actual peg,
# liquidity, or supply.
#
# Since v1.5 (Section 5.9): any hour whose own close is still within
# `sub_backfill_secs` (2h) of now posts through the sub-epoch path
# instead of the hourly one (12 posts at the 300s default, one per
# sub-epoch), mirroring the real schedule technical-doc.md Section
# 15.4 describes: a live keeper posts sub-epochs going forward, and
# only falls back to the hourly path for a gap older than its own
# 2h backfill window. Every older hour in range still posts through
# the existing hourly path (window_secs, 72h), since post_sub_signals
# cannot reach that far back at all — Sub(asset)'s own ring only ever
# holds 5 hours of wall-clock history. This is also why this script
# cannot seed the full 96 hours score() needs on its own: see the
# README / PR description for the exact timeline.
#
# Usage: deploy/post-demo-signals.sh testnet [epochs]
#   epochs: how many of the most recently closed epochs to post,
#           oldest first. Default 24. Capped at 71, one less than the
#           72h backfill window (window_secs): this script takes real
#           wall-clock minutes to run, and every post below recomputes
#           "now" and the newest closed epoch fresh rather than reusing
#           a value computed once at the start, so the OLDEST epoch
#           requested must still have at least one epoch of slack left
#           in the 72h window by the time its own turn comes, or it
#           could slide out from under it mid-run. Review finding (this
#           session): a 72-epoch request has no such slack at all.
#
# Order matters (deploy/README.md): run this BEFORE deploy/smoke-
# testnet.sh. smoke-testnet.sh's own write-check posts one epoch as a
# side effect if the asset has no history yet, which would otherwise
# claim FirstEpoch for whatever epoch happens to be newest at that
# moment, not the oldest one this script is about to backfill
# (FirstEpoch is write-once; see deploy/README.md and PR #35's own
# review for why this matters for when an asset starts scoring).

set -uo pipefail

NETWORK="${1:-}"
EPOCHS="${2:-24}"
if [[ "$NETWORK" != "testnet" ]]; then
  echo "usage: $0 testnet [epochs]" >&2
  exit 1
fi
if ! [[ "$EPOCHS" =~ ^[0-9]+$ ]] || (( EPOCHS < 1 || EPOCHS > 71 )); then
  echo "epochs must be an integer between 1 and 71 (one less than the 72h backfill window, so the oldest requested epoch always has slack left; see this script's own header comment)" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RECORD="$REPO_ROOT/deployments/testnet.json"
[[ -f "$RECORD" ]] || { echo "FATAL: $RECORD not found; run deploy/deploy.sh testnet first" >&2; exit 1; }

STELLAR_BIN="${STELLAR_CLI_BIN:-stellar}"
EPOCH_SECS=3600
SUB_EPOCH_SECS=300
SUB_BACKFILL_SECS=7200   # crate::SUB_BACKFILL_SECS: post_sub_signals's own backfill reach
SUBS_PER_HOUR=$(( EPOCH_SECS / SUB_EPOCH_SECS ))

RO_ID="$(jq -r '.contracts.risk_oracle.id' "$RECORD")"
KEEPER_ADDR="$(jq -r '.identities.keeper' "$RECORD")"
ASSET_ID="$(jq -r '.tracked_asset.contract_id' "$RECORD")"

log() { echo "==> $*"; }

# Review finding (this session): the ORIGINAL version of this script
# computed NOW and NEWEST_CLOSED_EPOCH once, here, then reused those
# stale values for the rest of the run. A 71-epoch backfill takes real
# wall-clock minutes to post; by the time the later iterations ran,
# enough real time had passed that an epoch the script still believed
# was safely in the past had not actually closed yet (or, for the
# sub-epoch path, had drifted past its own tighter close-time check),
# aborting the whole run partway with WrongEpoch. Every iteration below
# now recomputes "now" and the newest closed epoch fresh, immediately
# before its own post, instead of trusting a value computed at the top.
NOW_AT_START="$(date +%s)"
NEWEST_CLOSED_AT_START=$(( NOW_AT_START / EPOCH_SECS - 1 ))
FIRST_EPOCH=$(( NEWEST_CLOSED_AT_START - EPOCHS + 1 ))

log "Posting up to $EPOCHS synthetic demo epochs starting at $FIRST_EPOCH for $ASSET_ID"
log "These are SYNTHETIC values, not real USDC market observations."

INPUTS_FILE="$REPO_ROOT/deployments/testnet-demo-signals-inputs.json"
echo "[]" > "$INPUTS_FILE"

# Fixed baseline so supply_change_bps stays exactly 0 against the
# previous epoch every step (RiskOracle's own
# check_supply_change_consistency tolerates only
# SUPPLY_CHANGE_TOLERANCE_BPS = 1 of drift).
SUPPLY="10000000000000"       # 1,000,000 units at SCALE 1e7, arbitrary plausible size
LIQUIDITY="500000000000"      # 50,000 units at SCALE 1e7

post_hourly() {
  local epoch="$1" peg_ratio="$2" peg_ratio_p10="$3"

  local inputs_json
  inputs_json=$(jq -nc \
    --arg epoch "$epoch" \
    --arg peg_ratio "$peg_ratio" \
    --arg peg_ratio_p10 "$peg_ratio_p10" \
    --arg liquidity "$LIQUIDITY" \
    --arg supply "$SUPPLY" \
    '{epoch: ($epoch|tonumber), peg_ratio: ($peg_ratio|tonumber), peg_ratio_p10: ($peg_ratio_p10|tonumber), liquidity_2pct: ($liquidity|tonumber), supply: ($supply|tonumber), redemption_net: 0, supply_change_bps: 0, endpoint: "Unknown"}')
  local inputs_hash
  inputs_hash="$(printf '%s' "$inputs_json" | shasum -a 256 | cut -d' ' -f1)"

  jq --argjson entry "$(jq -nc --argjson inputs "$inputs_json" --arg hash "$inputs_hash" '{inputs: $inputs, inputs_hash: $hash, path: "hourly"}')" \
     '. += [$entry]' "$INPUTS_FILE" > "$INPUTS_FILE.tmp" && mv "$INPUTS_FILE.tmp" "$INPUTS_FILE"

  local signal_set="{\"epoch\":$epoch,\"posted_at\":0,\"peg_ratio\":\"$peg_ratio\",\"peg_ratio_p10\":\"$peg_ratio_p10\",\"liquidity_2pct\":\"$LIQUIDITY\",\"redemption_net\":\"0\",\"supply\":\"$SUPPLY\",\"supply_change_bps\":0,\"issuer_actions\":{\"clawbacks\":0,\"clawback_amount\":\"0\",\"auth_revocations\":0,\"flag_changes\":0},\"endpoint\":\"Unknown\",\"inputs_hash\":\"$inputs_hash\",\"poster\":\"$KEEPER_ADDR\"}"

  if ! "$STELLAR_BIN" contract invoke --id "$RO_ID" --source-account sylox-testnet-keeper --network testnet -- \
    post_signals --keeper "$KEEPER_ADDR" --asset "$ASSET_ID" --s "$signal_set" >/dev/null; then
    log "epoch $epoch FAILED via the hourly path (not a skip; see FATAL below)"
    return 1
  fi
  log "epoch $epoch posted via the hourly path (peg_ratio $(awk -v p="$peg_ratio" 'BEGIN { printf "%.4f", p/10000000 }'))"
}

post_sub_epochs() {
  local epoch="$1"
  local sub
  for (( sub = 0; sub < SUBS_PER_HOUR; sub++ )); do
    # Same small, deterministic noise convention as the hourly path,
    # varied per sub-epoch too so a build_hour roll-up has something
    # other than 12 identical values to average.
    local noise=$(( ((epoch * SUBS_PER_HOUR + sub) % 7) - 3 ))   # -3..3
    local peg_ratio=$(( 10000000 + noise * 1000 ))
    local peg_ratio_p10=$(( peg_ratio - 2000 ))

    local inputs_json
    inputs_json=$(jq -nc \
      --arg epoch "$epoch" --arg sub "$sub" \
      --arg peg_ratio "$peg_ratio" --arg peg_ratio_p10 "$peg_ratio_p10" \
      --arg liquidity "$LIQUIDITY" --arg supply "$SUPPLY" \
      '{hour: ($epoch|tonumber), sub: ($sub|tonumber), peg_ratio: ($peg_ratio|tonumber), peg_ratio_p10: ($peg_ratio_p10|tonumber), liquidity_2pct: ($liquidity|tonumber), supply: ($supply|tonumber), redemption_net: 0, supply_change_bps: 0, endpoint: "Unknown"}')
    local inputs_hash
    inputs_hash="$(printf '%s' "$inputs_json" | shasum -a 256 | cut -d' ' -f1)"

    jq --argjson entry "$(jq -nc --argjson inputs "$inputs_json" --arg hash "$inputs_hash" '{inputs: $inputs, inputs_hash: $hash, path: "sub_epoch"}')" \
       '. += [$entry]' "$INPUTS_FILE" > "$INPUTS_FILE.tmp" && mv "$INPUTS_FILE.tmp" "$INPUTS_FILE"

    local signal_set="{\"epoch\":$epoch,\"posted_at\":0,\"peg_ratio\":\"$peg_ratio\",\"peg_ratio_p10\":\"$peg_ratio_p10\",\"liquidity_2pct\":\"$LIQUIDITY\",\"redemption_net\":\"0\",\"supply\":\"$SUPPLY\",\"supply_change_bps\":0,\"issuer_actions\":{\"clawbacks\":0,\"clawback_amount\":\"0\",\"auth_revocations\":0,\"flag_changes\":0},\"endpoint\":\"Unknown\",\"inputs_hash\":\"$inputs_hash\",\"poster\":\"$KEEPER_ADDR\"}"

    if ! "$STELLAR_BIN" contract invoke --id "$RO_ID" --source-account sylox-testnet-keeper --network testnet -- \
      post_sub_signals --keeper "$KEEPER_ADDR" --asset "$ASSET_ID" --hour "$epoch" --sub "$sub" --s "$signal_set" >/dev/null; then
      log "epoch $epoch sub $sub FAILED via the sub-epoch path (not a skip; see FATAL below)"
      return 1
    fi
  done
  log "epoch $epoch posted via the sub-epoch path ($SUBS_PER_HOUR sub-epochs at ${SUB_EPOCH_SECS}s)"
}

FIRST_POSTED=""
LAST_POSTED=""
POSTED_COUNT=0
SKIPPED_COUNT=0

# Recomputed fresh each iteration (review finding above): a hot
# backfill loop can take real minutes to reach its later epochs, so
# "now" and "newest closed epoch" by the time THIS epoch's turn comes
# are not the same as they were when the script started.
for (( epoch = FIRST_EPOCH; epoch <= NEWEST_CLOSED_AT_START; epoch++ )); do
  NOW="$(date +%s)"
  NEWEST_CLOSED_NOW=$(( NOW / EPOCH_SECS - 1 ))
  if (( epoch > NEWEST_CLOSED_NOW )); then
    log "epoch $epoch is not closed yet (newest closed right now is $NEWEST_CLOSED_NOW); skipping, not aborting"
    SKIPPED_COUNT=$(( SKIPPED_COUNT + 1 ))
    continue
  fi

  epoch_close=$(( (epoch + 1) * EPOCH_SECS ))
  noise=$(( (epoch % 7) - 3 ))
  peg_ratio=$(( 10000000 + noise * 1000 ))
  peg_ratio_p10=$(( peg_ratio - 2000 ))

  if (( NOW - epoch_close <= SUB_BACKFILL_SECS )); then
    post_sub_epochs "$epoch" || { echo "FATAL: epoch $epoch failed via the sub-epoch path (a real error, not a timing skip)" >&2; exit 1; }
  else
    post_hourly "$epoch" "$peg_ratio" "$peg_ratio_p10" || { echo "FATAL: epoch $epoch failed via the hourly path (a real error, not a timing skip)" >&2; exit 1; }
  fi

  [[ -z "$FIRST_POSTED" ]] && FIRST_POSTED="$epoch"
  LAST_POSTED="$epoch"
  POSTED_COUNT=$(( POSTED_COUNT + 1 ))
done

log "Inputs written to $INPUTS_FILE"
if [[ -n "$FIRST_POSTED" ]]; then
  log "Posted $POSTED_COUNT epoch(s), [$FIRST_POSTED, $LAST_POSTED]; skipped $SKIPPED_COUNT not-yet-closed epoch(s)."
else
  log "Posted 0 epochs; skipped $SKIPPED_COUNT not-yet-closed epoch(s). Nothing to read back."
fi

NOW="$(date +%s)"
PENDING_UNTIL=$(( NOW + 7200 ))  # SIGNAL_DISPUTE_SECS
log "Every epoch just posted is Pending; becomes Final once now >= posted_at + signal_dispute_secs (2h)."
log "Finality for this batch is due at $(date -u -r "$PENDING_UNTIL" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$PENDING_UNTIL" +%Y-%m-%dT%H:%M:%SZ) UTC. This script does not wait for it."

log "--- Read-back ---"
newest="$("$STELLAR_BIN" contract invoke --id "$RO_ID" --source-account sylox-testnet-keeper --network testnet --send=no -- newest_epoch --asset "$ASSET_ID")"
log "newest_epoch: $newest"
latest="$("$STELLAR_BIN" contract invoke --id "$RO_ID" --source-account sylox-testnet-keeper --network testnet --send=no -- latest --asset "$ASSET_ID")"
log "latest: $latest"
live="$("$STELLAR_BIN" contract invoke --id "$RO_ID" --source-account sylox-testnet-keeper --network testnet --send=no -- live --asset "$ASSET_ID")"
log "live: $live"
score="$("$STELLAR_BIN" contract invoke --id "$RO_ID" --source-account sylox-testnet-keeper --network testnet --send=no -- score --asset "$ASSET_ID")"
log "score: $score"
band="$("$STELLAR_BIN" contract invoke --id "$RO_ID" --source-account sylox-testnet-keeper --network testnet --send=no -- band --asset "$ASSET_ID")"
log "band: $band"
