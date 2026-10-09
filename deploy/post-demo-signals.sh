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
# Usage: deploy/post-demo-signals.sh testnet [epochs]
#   epochs: how many of the most recently closed epochs to post,
#           oldest first. Default 24. Capped by the 72h backfill
#           window (window_secs): posting more than 72 epochs back
#           from now would be rejected by RiskOracle's own
#           check_epoch_window.

set -euo pipefail

NETWORK="${1:-}"
EPOCHS="${2:-24}"
if [[ "$NETWORK" != "testnet" ]]; then
  echo "usage: $0 testnet [epochs]" >&2
  exit 1
fi
if ! [[ "$EPOCHS" =~ ^[0-9]+$ ]] || (( EPOCHS < 1 || EPOCHS > 72 )); then
  echo "epochs must be an integer between 1 and 72 (the backfill window)" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RECORD="$REPO_ROOT/deployments/testnet.json"
[[ -f "$RECORD" ]] || { echo "FATAL: $RECORD not found; run deploy/deploy.sh testnet first" >&2; exit 1; }

STELLAR_BIN="${STELLAR_CLI_BIN:-stellar}"
EPOCH_SECS=3600

RO_ID="$(jq -r '.contracts.risk_oracle.id' "$RECORD")"
KEEPER_ADDR="$(jq -r '.identities.keeper' "$RECORD")"
ASSET_ID="$(jq -r '.tracked_asset.contract_id' "$RECORD")"

log() { echo "==> $*"; }

NOW="$(date +%s)"
# The newest epoch SAFELY closed right now: epoch_close = (e+1)*EPOCH_SECS
# must be <= NOW, so the newest usable e is floor(NOW/EPOCH_SECS) - 1.
NEWEST_CLOSED_EPOCH=$(( NOW / EPOCH_SECS - 1 ))
FIRST_EPOCH=$(( NEWEST_CLOSED_EPOCH - EPOCHS + 1 ))

log "Posting $EPOCHS synthetic demo epochs [$FIRST_EPOCH, $NEWEST_CLOSED_EPOCH] for $ASSET_ID"
log "These are SYNTHETIC values, not real USDC market observations."

INPUTS_FILE="$REPO_ROOT/deployments/testnet-demo-signals-inputs.json"
echo "[]" > "$INPUTS_FILE"

# Fixed baseline so supply_change_bps stays exactly 0 against the
# previous epoch every step (RiskOracle's own
# check_supply_change_consistency tolerates only
# SUPPLY_CHANGE_TOLERANCE_BPS = 1 of drift).
SUPPLY="10000000000000"       # 1,000,000 units at SCALE 1e7, arbitrary plausible size
LIQUIDITY="500000000000"      # 50,000 units at SCALE 1e7

for (( epoch = FIRST_EPOCH; epoch <= NEWEST_CLOSED_EPOCH; epoch++ )); do
  # Small, plausible noise around a 1.0 peg: +/- 0.001, deterministic
  # per epoch so re-running with the same epoch range is reproducible.
  noise=$(( (epoch % 7) - 3 ))                  # -3..3
  peg_ratio=$(( 10000000 + noise * 1000 ))       # 1.0 +/- 0.003, SCALE 1e7
  peg_ratio_p10=$(( peg_ratio - 2000 ))          # p10 slightly below the mean, never above (sanity bound)

  inputs_json=$(jq -nc \
    --arg epoch "$epoch" \
    --arg peg_ratio "$peg_ratio" \
    --arg peg_ratio_p10 "$peg_ratio_p10" \
    --arg liquidity "$LIQUIDITY" \
    --arg supply "$SUPPLY" \
    '{epoch: ($epoch|tonumber), peg_ratio: ($peg_ratio|tonumber), peg_ratio_p10: ($peg_ratio_p10|tonumber), liquidity_2pct: ($liquidity|tonumber), supply: ($supply|tonumber), redemption_net: 0, supply_change_bps: 0, endpoint: "Unknown"}')
  inputs_hash="$(printf '%s' "$inputs_json" | shasum -a 256 | cut -d' ' -f1)"

  jq --argjson entry "$(jq -nc --argjson inputs "$inputs_json" --arg hash "$inputs_hash" '{inputs: $inputs, inputs_hash: $hash}')" \
     '. += [$entry]' "$INPUTS_FILE" > "$INPUTS_FILE.tmp" && mv "$INPUTS_FILE.tmp" "$INPUTS_FILE"

  signal_set="{\"epoch\":$epoch,\"posted_at\":0,\"peg_ratio\":\"$peg_ratio\",\"peg_ratio_p10\":\"$peg_ratio_p10\",\"liquidity_2pct\":\"$LIQUIDITY\",\"redemption_net\":\"0\",\"supply\":\"$SUPPLY\",\"supply_change_bps\":0,\"issuer_actions\":{\"clawbacks\":0,\"clawback_amount\":\"0\",\"auth_revocations\":0,\"flag_changes\":0},\"endpoint\":\"Unknown\",\"inputs_hash\":\"$inputs_hash\",\"poster\":\"$KEEPER_ADDR\"}"

  "$STELLAR_BIN" contract invoke --id "$RO_ID" --source-account sylox-testnet-keeper --network testnet -- \
    post_signals --keeper "$KEEPER_ADDR" --asset "$ASSET_ID" --s "$signal_set" >/dev/null
  log "epoch $epoch posted (peg_ratio $(awk -v p="$peg_ratio" 'BEGIN { printf "%.4f", p/10000000 }'))"
done

log "Inputs written to $INPUTS_FILE"

PENDING_UNTIL=$(( NOW + 7200 ))  # SIGNAL_DISPUTE_SECS
log "Every epoch just posted is Pending; becomes Final once now >= posted_at + signal_dispute_secs (2h)."
log "Finality for this batch is due at $(date -u -r "$PENDING_UNTIL" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$PENDING_UNTIL" +%Y-%m-%dT%H:%M:%SZ) UTC. This script does not wait for it."

log "--- Read-back ---"
newest="$("$STELLAR_BIN" contract invoke --id "$RO_ID" --source-account sylox-testnet-keeper --network testnet --send=no -- newest_epoch --asset "$ASSET_ID")"
log "newest_epoch: $newest"
latest="$("$STELLAR_BIN" contract invoke --id "$RO_ID" --source-account sylox-testnet-keeper --network testnet --send=no -- latest --asset "$ASSET_ID")"
log "latest: $latest"
score="$("$STELLAR_BIN" contract invoke --id "$RO_ID" --source-account sylox-testnet-keeper --network testnet --send=no -- score --asset "$ASSET_ID")"
log "score: $score"
band="$("$STELLAR_BIN" contract invoke --id "$RO_ID" --source-account sylox-testnet-keeper --network testnet --send=no -- band --asset "$ASSET_ID")"
log "band: $band"
