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
#        deploy/post-demo-signals.sh testnet --live
#
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
#   --live: run ONE pass of live, ongoing posting instead of a backfill.
#           Intended to be invoked on a fixed interval (every 5 minutes,
#           first on a local machine as a stopgap, then as a Railway
#           cron job once this merges), never as a long-running process
#           itself. Posts every closed, not-yet-posted sub-epoch of the
#           CURRENT hour and the PREVIOUS hour (so a single missed
#           5-minute tick still gets caught up on the next one), reading
#           the asset's real `sub_epoch_secs` from RiskOracle.sub_epoch_
#           config rather than assuming the 300s default. Never falls
#           back to the hourly path: hours build on their own once every
#           one of their sub-epochs settles (Section 5.9 S4). A sub-
#           epoch that is already posted (Error #103/#115) is a normal,
#           expected skip (the common case on most 5-minute ticks,
#           since a sub-epoch only closes once every `sub_epoch_secs`),
#           not a failure; only a genuinely different error exits
#           non-zero. Review finding (this session): posting ONE epoch
#           (12 sub-epochs at once) every 5 minutes, the original plan,
#           would lag the real clock by up to an hour and make every
#           one of the next 11 ticks fail outright on "already posted"
#           instead of recognizing it as expected.
#
# Order matters (deploy/README.md): run a backfill (the `epochs` form)
# BEFORE deploy/smoke-testnet.sh, and before the first `--live` run.
# smoke-testnet.sh's own write-check posts one epoch as a side effect
# if the asset has no history yet, which would otherwise claim
# FirstEpoch for whatever epoch happens to be newest at that moment,
# not the oldest one a backfill is about to post (FirstEpoch is
# write-once; see deploy/README.md and PR #35's own review for why
# this matters for when an asset starts scoring).

set -uo pipefail

NETWORK="${1:-}"
MODE="${2:-24}"
if [[ "$NETWORK" != "testnet" ]]; then
  echo "usage: $0 testnet [epochs|--live]" >&2
  exit 1
fi

LIVE_MODE=0
EPOCHS=""
if [[ "$MODE" == "--live" ]]; then
  LIVE_MODE=1
elif [[ "$MODE" =~ ^[0-9]+$ ]] && (( MODE >= 1 && MODE <= 71 )); then
  EPOCHS="$MODE"
else
  echo "usage: $0 testnet [epochs|--live]" >&2
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

# Review finding (this session): `stellar contract invoke`'s own exit
# code alone cannot tell an expected "already posted" skip (Error #103
# EpochAlreadyPosted, #115 HourAlreadyPosted) apart from a genuine
# failure; both exit non-zero identically. Capture stderr and grep it
# instead of trusting the exit code's value alone.
is_already_posted_error() {
  [[ "$1" == *"Error(Contract, #103)"* || "$1" == *"Error(Contract, #115)"* ]]
}

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
if (( ! LIVE_MODE )); then
  NOW_AT_START="$(date +%s)"
  NEWEST_CLOSED_AT_START=$(( NOW_AT_START / EPOCH_SECS - 1 ))
  FIRST_EPOCH=$(( NEWEST_CLOSED_AT_START - EPOCHS + 1 ))

  log "Posting up to $EPOCHS synthetic demo epochs starting at $FIRST_EPOCH for $ASSET_ID"
  log "These are SYNTHETIC values, not real USDC market observations."

  INPUTS_FILE="$REPO_ROOT/deployments/testnet-demo-signals-inputs.json"
  echo "[]" > "$INPUTS_FILE"
fi

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
  local sub posted=0 skipped_stale=0
  for (( sub = 0; sub < SUBS_PER_HOUR; sub++ )); do
    # Review finding (this session): post_sub_signals's own
    # check_sub_epoch_window rejects a sub-epoch once `now - sub_close
    # > SUB_BACKFILL_SECS` (2h) — a per-SUB-EPOCH staleness bound, not
    # the per-HOUR one this function's own caller already checks.
    # sub_close = epoch*EPOCH_SECS + sub*SUB_EPOCH_SECS + SUB_EPOCH_SECS,
    # strictly EARLIER than the hour's own close for every sub before
    # the last, so an hour that is itself still safely within its own
    # 2h backfill window can still have its EARLY sub-epochs (sub 0,
    # 1, 2…) go stale first — a 71-epoch backfill run takes long
    # enough in real wall-clock minutes that this was observed to
    # happen for real, on the LAST hour of a run. Skip (not fail) a
    # sub-epoch whose own window has closed: the contract's own
    # MissingWithinBackfill/PermanentlyMissing dispositions already
    # handle a sub-epoch nobody ever posts, same as any other gap.
    local sub_close=$(( epoch * EPOCH_SECS + sub * SUB_EPOCH_SECS + SUB_EPOCH_SECS ))
    local now_check
    now_check="$(date +%s)"
    if (( now_check - sub_close > SUB_BACKFILL_SECS )); then
      log "epoch $epoch sub $sub is stale by itself (sub-epoch's own 2h backfill window has closed); skipping, not aborting"
      skipped_stale=$(( skipped_stale + 1 ))
      continue
    fi

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
    posted=$(( posted + 1 ))
  done
  log "epoch $epoch posted via the sub-epoch path ($posted/$SUBS_PER_HOUR sub-epochs posted, $skipped_stale skipped as individually stale, at ${SUB_EPOCH_SECS}s)"
}

# Posts ONE sub-epoch (hour, sub) for live mode. Unlike post_sub_epochs
# (the backfill helper above, which posts a whole hour's worth and
# treats ANY failure as fatal), this posts a single sub-epoch and
# treats "already posted" (Error #103/#115) as an ordinary, silent-to-
# the-caller skip: live mode calls this once per closed sub-epoch in
# its own two-hour lookback, and most of those, on most 5-minute ticks,
# will already be posted. Echoes one of "posted"/"skipped"/"error" via
# its own return code (0/0/1) and stdout, rather than logging here
# directly, so the caller can keep one tally across many calls instead
# of one log line per sub-epoch.
post_one_sub_epoch() {
  local hour="$1" sub="$2" sub_epoch_secs="$3"

  local noise=$(( ((hour * (EPOCH_SECS / sub_epoch_secs) + sub) % 7) - 3 ))   # -3..3
  local peg_ratio=$(( 10000000 + noise * 1000 ))
  local peg_ratio_p10=$(( peg_ratio - 2000 ))
  local inputs_hash
  inputs_hash="$(printf '%s' "live:$hour:$sub:$peg_ratio" | shasum -a 256 | cut -d' ' -f1)"
  local signal_set="{\"epoch\":$hour,\"posted_at\":0,\"peg_ratio\":\"$peg_ratio\",\"peg_ratio_p10\":\"$peg_ratio_p10\",\"liquidity_2pct\":\"$LIQUIDITY\",\"redemption_net\":\"0\",\"supply\":\"$SUPPLY\",\"supply_change_bps\":0,\"issuer_actions\":{\"clawbacks\":0,\"clawback_amount\":\"0\",\"auth_revocations\":0,\"flag_changes\":0},\"endpoint\":\"Unknown\",\"inputs_hash\":\"$inputs_hash\",\"poster\":\"$KEEPER_ADDR\"}"

  local out
  if out="$("$STELLAR_BIN" contract invoke --id "$RO_ID" --source-account sylox-testnet-keeper --network testnet -- \
    post_sub_signals --keeper "$KEEPER_ADDR" --asset "$ASSET_ID" --hour "$hour" --sub "$sub" --s "$signal_set" 2>&1)"; then
    echo "posted"
    return 0
  fi
  if is_already_posted_error "$out"; then
    echo "skipped"
    return 0
  fi
  echo "error: $out"
  return 1
}

# --live: posts every closed, not-yet-posted sub-epoch of the current
# hour and the previous hour (review finding above: catches up a
# single missed 5-minute tick without ever posting the hourly
# fallback, which would lock the hour against any further sub-epoch
# posting at all, see post_sub_signals's own HourAlreadyPosted check).
run_live_mode() {
  local now hour_now sub_epoch_secs per_hour
  now="$(date +%s)"
  hour_now=$(( now / EPOCH_SECS ))

  local cfg sub_epoch_secs_current sub_epoch_secs_pending effective_from_hour
  cfg="$("$STELLAR_BIN" contract invoke --id "$RO_ID" --source-account sylox-testnet-keeper --network testnet --send=no -- sub_epoch_config --asset "$ASSET_ID" 2>&1)"
  if [[ "$cfg" == "null" || -z "$cfg" ]]; then
    echo "FATAL: sub_epoch_config(asset) is null; set_sub_epoch_secs must be called before --live can run" >&2
    exit 1
  fi
  sub_epoch_secs_current="$(echo "$cfg" | jq -r '.sub_epoch_secs')"
  sub_epoch_secs_pending="$(echo "$cfg" | jq -r '.pending_sub_epoch_secs')"
  effective_from_hour="$(echo "$cfg" | jq -r '.effective_from_hour')"

  # Mirrors current_sub_epoch_secs's own logic (contracts/risk-oracle/
  # src/lib.rs): the pending value governs once the hour in question
  # reaches effective_from_hour, the current value otherwise.
  sub_epoch_secs_for_hour() {
    local hour="$1"
    if [[ "$sub_epoch_secs_pending" != "null" && "$effective_from_hour" != "null" ]] \
       && (( hour >= effective_from_hour )); then
      echo "$sub_epoch_secs_pending"
    else
      echo "$sub_epoch_secs_current"
    fi
  }

  local posted=0 skipped=0
  local posted_list="" skipped_list=""

  local hour
  for hour in $(( hour_now - 1 )) "$hour_now"; do
    sub_epoch_secs="$(sub_epoch_secs_for_hour "$hour")"
    per_hour=$(( EPOCH_SECS / sub_epoch_secs ))
    local sub
    for (( sub = 0; sub < per_hour; sub++ )); do
      local sub_start sub_close
      sub_start=$(( hour * EPOCH_SECS + sub * sub_epoch_secs ))
      sub_close=$(( sub_start + sub_epoch_secs ))
      now="$(date +%s)"
      if (( sub_close > now )); then
        continue   # Not closed yet; not even attempted, not counted as a skip.
      fi

      local result
      result="$(post_one_sub_epoch "$hour" "$sub" "$sub_epoch_secs")"
      case "$result" in
        posted)
          posted=$(( posted + 1 ))
          posted_list+="$hour.$sub "
          ;;
        skipped)
          skipped=$(( skipped + 1 ))
          skipped_list+="$hour.$sub "
          ;;
        *)
          echo "FATAL: hour $hour sub $sub: $result" >&2
          exit 1
          ;;
      esac
    done
  done

  log "live: posted $posted sub-epoch(s) [${posted_list% }], skipped $skipped already-posted [${skipped_list% }]"
}

if (( LIVE_MODE )); then
  log "Running one --live pass for $ASSET_ID (current and previous hour's closed sub-epochs only)"
  run_live_mode
else
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
fi

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
