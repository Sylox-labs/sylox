#!/usr/bin/env bash
# Creates a DEMOUSD holder, posts DEMOUSD's own signal history, then
# performs a REAL authorization revocation and a REAL clawback against
# that holder from the DEMOUSD issuer, posts a signal recording those
# exact actions (with the real transaction hashes in the inputs), and
# calls propose_tier1(DEMOUSD, IssuerFreeze).
#
# Run deploy/demo-asset.sh testnet first; this script reads
# deployments/testnet-demo-asset.json, which that script writes.
#
# technical-doc.md Section 8.2 / contracts/event-registry/src/lib.rs's
# own check_issuer_freeze: unlike score()'s 7 day calendar requirement
# (Section 6.5), IssuerFreeze's own 168-epoch window has NO history
# minimum — a missing epoch only undercounts, never falsely triggers
# (PR #27 review round 2, see check_issuer_freeze's own doc comment).
# DEMOUSD does not need a long backfill: it needs ONE Final epoch
# holding real supply (for the clawback_amount/supply percentage) and
# ONE Final epoch (the same one, here) holding the real revocation/
# clawback counts. This script backfills a SMALL number of hours
# (default 3, oldest first, matching deploy/post-demo-signals.sh's own
# convention) purely so DEMOUSD has a real `supply` to divide by and a
# `latest_supply` the loop in check_issuer_freeze can read, then posts
# the triggering hour itself with the real on-chain action counts.
#
# Usage: deploy/demo-asset-trigger.sh testnet [backfill_hours]
#   backfill_hours: hours of plain DEMOUSD history to post before the
#                   triggering post, oldest first. Default 3, capped
#                   at 71 (same bound as post-demo-signals.sh, for the
#                   same reason).

set -uo pipefail

NETWORK="${1:-}"
BACKFILL_HOURS="${2:-3}"
if [[ "$NETWORK" != "testnet" ]]; then
  echo "usage: $0 testnet [backfill_hours]" >&2
  exit 1
fi
if ! [[ "$BACKFILL_HOURS" =~ ^[0-9]+$ ]] || (( BACKFILL_HOURS < 1 || BACKFILL_HOURS > 71 )); then
  echo "backfill_hours must be an integer between 1 and 71" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RECORD="$REPO_ROOT/deployments/testnet.json"
DEMO_RECORD="$REPO_ROOT/deployments/testnet-demo-asset.json"
[[ -f "$RECORD" ]] || { echo "FATAL: $RECORD not found; run deploy/deploy.sh testnet first" >&2; exit 1; }
[[ -f "$DEMO_RECORD" ]] || { echo "FATAL: $DEMO_RECORD not found; run deploy/demo-asset.sh testnet first" >&2; exit 1; }

STELLAR_BIN="${STELLAR_CLI_BIN:-stellar}"
EPOCH_SECS=3600

RO_ID="$(jq -r '.contracts.risk_oracle.id' "$RECORD")"
KEEPER_ADDR="$(jq -r '.identities.keeper' "$RECORD")"
DEMO_ID="$(jq -r '.demo_asset.contract_id' "$DEMO_RECORD")"
DEMO_CODE="$(jq -r '.demo_asset.asset_code' "$DEMO_RECORD")"
DEMO_ISSUER_ADDR="$(jq -r '.demo_asset.issuer' "$DEMO_RECORD")"
DEMO_ISSUER=sylox-demo-issuer

log() { echo "==> $*"; }
die() { echo "FATAL: $*" >&2; exit 1; }

SUPPLY="10000000000000"      # 1,000,000 units at SCALE 1e7, same convention as post-demo-signals.sh.
LIQUIDITY="500000000000"     # 50,000 units at SCALE 1e7.

# -- [1/6] Holder identity and trustline -----------------------------

log "[1/6] DEMOUSD holder identity"
HOLDER=sylox-demo-holder
if "$STELLAR_BIN" keys address "$HOLDER" >/dev/null 2>&1; then
  log "identity $HOLDER already exists"
else
  "$STELLAR_BIN" keys generate "$HOLDER" --network testnet --fund
  log "identity $HOLDER created and funded"
fi
HOLDER_ADDR="$("$STELLAR_BIN" keys address "$HOLDER")"

log "Opening $HOLDER's trustline to $DEMO_CODE:$DEMO_ISSUER_ADDR"
# A repeat change-trust to an already-open trustline is a harmless
# no-op on Stellar (same limit, same flags), so no "already exists"
# branch is needed here, unlike the SAC/asset-registration steps.
"$STELLAR_BIN" tx new change-trust --source-account "$HOLDER" \
  --line "$DEMO_CODE:$DEMO_ISSUER_ADDR" --network testnet >/dev/null

# -- [2/6] Issue the holder some DEMOUSD -----------------------------

HOLDER_BALANCE=1000000000   # 100 units at SCALE 1e7, arbitrary plausible size, enough to partially clawback.
log "[2/6] Issuing $HOLDER_BALANCE DEMOUSD to $HOLDER_ADDR"
"$STELLAR_BIN" contract invoke --id "$DEMO_ID" --source-account "$DEMO_ISSUER" \
  --network testnet -- mint --to "$HOLDER_ADDR" --amount "$HOLDER_BALANCE" >/dev/null
log "minted $HOLDER_BALANCE DEMOUSD to $HOLDER_ADDR"

# -- [3/6] Backfill plain DEMOUSD history (oldest first) -------------
#
# No real issuer action in these hours: just real supply/liquidity
# numbers, the same convention post-demo-signals.sh uses, so
# check_issuer_freeze's own latest_supply has something real to read
# even on the triggering epoch itself (clawback_sum / latest_supply).

log "[3/6] Backfilling $BACKFILL_HOURS hour(s) of plain DEMOUSD history"
NOW="$(date +%s)"
NEWEST_CLOSED=$(( NOW / EPOCH_SECS - 1 ))
FIRST_EPOCH=$(( NEWEST_CLOSED - BACKFILL_HOURS ))   # Leaves the newest closed hour for the triggering post itself.

for (( epoch = FIRST_EPOCH; epoch < NEWEST_CLOSED; epoch++ )); do
  inputs_hash="$(printf 'demo-asset-backfill:%s' "$epoch" | shasum -a 256 | cut -d' ' -f1)"
  signal_set="{\"epoch\":$epoch,\"posted_at\":0,\"peg_ratio\":\"10000000\",\"peg_ratio_p10\":\"9998000\",\"liquidity_2pct\":\"$LIQUIDITY\",\"redemption_net\":\"0\",\"supply\":\"$SUPPLY\",\"supply_change_bps\":0,\"issuer_actions\":{\"clawbacks\":0,\"clawback_amount\":\"0\",\"auth_revocations\":0,\"flag_changes\":0},\"endpoint\":\"Unknown\",\"inputs_hash\":\"$inputs_hash\",\"poster\":\"$KEEPER_ADDR\"}"
  if ! post_out="$("$STELLAR_BIN" contract invoke --id "$RO_ID" --source-account sylox-testnet-keeper --network testnet -- \
    post_signals --keeper "$KEEPER_ADDR" --asset "$DEMO_ID" --s "$signal_set" 2>&1)"; then
    if [[ "$post_out" == *"Error(Contract, #103)"* ]]; then
      log "epoch $epoch already posted; skipping"
      continue
    fi
    die "post_signals(DEMOUSD, $epoch) failed:
$post_out"
  fi
  log "epoch $epoch posted (plain history)"
done

# -- [4/6] The real revocation and clawback --------------------------
#
# Real on-chain transactions against the holder's own trustline, from
# the issuer: this is what makes the event genuine, not a posted
# claim. CLAWBACK_ENABLED was set on the issuer BEFORE this trustline
# was opened in step 1 (deploy/demo-asset.sh's own step 2, a Stellar
# protocol requirement, not a Sylox one), so the clawback below is
# valid.

CLAWBACK_AMOUNT=500000000   # 50 of the holder's 100 DEMOUSD, at SCALE 1e7.

log "[4/6] Revoking $HOLDER_ADDR's authorization for $DEMO_CODE"
if ! revoke_out="$("$STELLAR_BIN" tx new set-trustline-flags --source-account "$DEMO_ISSUER" --network testnet \
  --trustor "$HOLDER_ADDR" --asset "$DEMO_CODE:$DEMO_ISSUER_ADDR" --clear-authorize 2>&1)"; then
  die "revoking $HOLDER_ADDR's authorization failed:
$revoke_out"
fi
echo "$revoke_out"
REVOKE_TX_HASH="$(echo "$revoke_out" | grep -oE '[a-f0-9]{64}' | head -1)"
log "revocation transaction: $REVOKE_TX_HASH"

log "Clawing back $CLAWBACK_AMOUNT from $HOLDER_ADDR"
if ! clawback_out="$("$STELLAR_BIN" tx new clawback --source-account "$DEMO_ISSUER" --network testnet \
  --from "$HOLDER_ADDR" --asset "$DEMO_CODE:$DEMO_ISSUER_ADDR" --amount "$CLAWBACK_AMOUNT" 2>&1)"; then
  die "clawback from $HOLDER_ADDR failed:
$clawback_out"
fi
echo "$clawback_out"
CLAWBACK_TX_HASH="$(echo "$clawback_out" | grep -oE '[a-f0-9]{64}' | head -1)"
log "clawback transaction: $CLAWBACK_TX_HASH"

# -- [5/6] Post the triggering signal, with the real tx hashes --------
#
# The keeper posts THIS hour's signal set with issuer_actions showing
# exactly the revocation and clawback amount just performed above, and
# the real transaction hashes folded into the inputs the keeper hashes
# (inputs_hash), so anyone can check the posted numbers against the
# chain: the hashes are real stellar.expert-linkable transaction ids,
# not invented values.

log "[5/6] Posting the triggering signal for hour $NEWEST_CLOSED"
inputs_json=$(jq -nc \
  --arg epoch "$NEWEST_CLOSED" \
  --arg clawback_amount "$CLAWBACK_AMOUNT" \
  --arg revoke_tx "$REVOKE_TX_HASH" \
  --arg clawback_tx "$CLAWBACK_TX_HASH" \
  '{epoch: ($epoch|tonumber), clawback_amount: ($clawback_amount|tonumber), auth_revocations: 1, revoke_tx_hash: $revoke_tx, clawback_tx_hash: $clawback_tx}')
inputs_hash="$(printf '%s' "$inputs_json" | shasum -a 256 | cut -d' ' -f1)"
signal_set="{\"epoch\":$NEWEST_CLOSED,\"posted_at\":0,\"peg_ratio\":\"10000000\",\"peg_ratio_p10\":\"9998000\",\"liquidity_2pct\":\"$LIQUIDITY\",\"redemption_net\":\"0\",\"supply\":\"$SUPPLY\",\"supply_change_bps\":0,\"issuer_actions\":{\"clawbacks\":1,\"clawback_amount\":\"$CLAWBACK_AMOUNT\",\"auth_revocations\":1,\"flag_changes\":0},\"endpoint\":\"Unknown\",\"inputs_hash\":\"$inputs_hash\",\"poster\":\"$KEEPER_ADDR\"}"
if ! trigger_out="$("$STELLAR_BIN" contract invoke --id "$RO_ID" --source-account sylox-testnet-keeper --network testnet -- \
  post_signals --keeper "$KEEPER_ADDR" --asset "$DEMO_ID" --s "$signal_set" 2>&1)"; then
  die "post_signals(DEMOUSD, $NEWEST_CLOSED, the triggering signal) failed:
$trigger_out"
fi
echo "$trigger_out"
log "triggering signal posted for epoch $NEWEST_CLOSED: clawback_amount=$CLAWBACK_AMOUNT, auth_revocations=1"
log "inputs (with real tx hashes): $inputs_json"

PENDING_UNTIL=$(( $(date +%s) + 7200 ))
log "This signal is Pending until $(date -u -r "$PENDING_UNTIL" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$PENDING_UNTIL" +%Y-%m-%dT%H:%M:%SZ) UTC (signal_dispute_secs, 2h), then effectively Final."
log "propose_tier1 reads effectively-Final slots (ADR-008): this script does NOT wait for that; run deploy/demo-asset-propose.sh testnet once that time has passed."
