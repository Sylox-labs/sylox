#!/usr/bin/env bash
# ONE-TIME script: creates a DEMOUSD holder, posts a little real
# history, then performs a REAL authorization revocation and a REAL
# clawback against that holder from the DEMOUSD issuer, posts a
# signal recording those exact actions (amount and supply read back
# from the chain, never hardcoded; the real transaction hashes folded
# into the posted inputs), and refuses to post if the real numbers
# would not actually clear the registered IssuerFreeze threshold.
#
# Run deploy/demo-asset.sh testnet first; this script reads
# deployments/testnet.json and deployments/testnet-demo-asset.json,
# which that script writes.
#
# Running this script TWICE mints a second batch and claws back a
# second amount; it is not meant to be re-run to "redo" the demo, only
# to retry a step that failed partway (minting is the one step below
# with no "already done" guard, since there's no natural amount to
# check against — a second deliberate mint is a legitimate thing to
# want, just not from re-running this whole script by habit). If the
# demo needs resetting, that means a fresh holder identity and a fresh
# DEMOUSD asset (deploy/demo-asset.sh again, under a different issuer),
# not re-running this script against the same holder.
#
# technical-doc.md Section 8.2 / contracts/event-registry/src/lib.rs's
# own check_issuer_freeze: unlike score()'s 7 day calendar requirement
# (Section 6.5), IssuerFreeze's own 168-epoch window has NO history
# minimum — a missing epoch only undercounts, never falsely triggers
# (PR #27 review round 2, see check_issuer_freeze's own doc comment).
# DEMOUSD does not need a long backfill: it needs ONE Final epoch
# holding real supply (for the clawback_amount/supply percentage) and
# ONE Final epoch (the same one, here) holding the real revocation/
# clawback counts.
#
# Review finding (this session): a FIRST version of this script posted
# an invented, round SUPPLY figure (1,000,000 units) unrelated to what
# was actually minted (100 units) and clawed back (50 units).
# check_issuer_freeze computes clawback_amount * 10000 / supply in
# INTEGER arithmetic; the real 50-of-100 (50%) became a fictional
# 50-of-1,000,000 (0.005%, truncating to 0 bps), so propose_tier1
# failed. Fixed by reading the REAL circulating supply from Horizon at
# the moment of posting (every field below marked "real" is read from
# the chain, not invented), and by refusing to post at all if the real
# numbers would not clear the registered threshold (step 5).
#
# Which fields are real, which are sample:
#   - peg_ratio, peg_ratio_p10, liquidity_2pct: SAMPLE. DEMOUSD has no
#     real market to observe a peg or liquidity from; these are
#     plausible placeholder values, the same convention deploy/post-
#     demo-signals.sh uses for USDC's own synthetic backfill.
#   - supply: REAL. Read from Horizon's asset-stats endpoint
#     immediately before each post (steps 3 and 5), the actual
#     authorized + authorized_to_maintain_liabilities + unauthorized
#     balance total for DEMOUSD at that moment.
#   - clawback_amount, auth_revocations: REAL. The revocation and
#     clawback in step 4 are genuine Stellar operations against the
#     holder's own trustline; clawback_amount is read back from the
#     clawback transaction's own Horizon effects (the amount it
#     actually moved), never the amount requested.
#   - revoke_tx_hash, clawback_tx_hash: REAL transaction hashes,
#     stellar.expert-linkable, folded into the posted inputs so anyone
#     can check the posted numbers against the chain.
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
HORIZON_URL="https://horizon-testnet.stellar.org"

RO_ID="$(jq -r '.contracts.risk_oracle.id' "$RECORD")"
ER_ID="$(jq -r '.contracts.event_registry.id' "$RECORD")"
KEEPER_ADDR="$(jq -r '.identities.keeper' "$RECORD")"
DEMO_ID="$(jq -r '.demo_asset.contract_id' "$DEMO_RECORD")"
DEMO_CODE="$(jq -r '.demo_asset.asset_code' "$DEMO_RECORD")"
DEMO_ISSUER_ADDR="$(jq -r '.demo_asset.issuer' "$DEMO_RECORD")"
DEMO_ISSUER=sylox-demo-issuer

log() { echo "==> $*"; }
die() { echo "FATAL: $*" >&2; exit 1; }

# Real circulating supply for DEMOUSD, in stroops (SCALE 1e7), read
# fresh from Horizon every time it's needed: authorized +
# authorized_to_maintain_liabilities + unauthorized balances, the
# total actually issued and held outside the issuer account (the
# issuer's own SAC balance always reads as effectively unlimited, not
# a real supply figure).
read_real_supply() {
  local stats
  stats="$(curl -sSf "$HORIZON_URL/assets?asset_code=$DEMO_CODE&asset_issuer=$DEMO_ISSUER_ADDR" 2>&1)" \
    || die "could not read DEMOUSD's asset stats from Horizon: $stats"
  local authorized maintain unauthorized
  authorized="$(echo "$stats" | jq -r '._embedded.records[0].balances.authorized // "0"')"
  maintain="$(echo "$stats" | jq -r '._embedded.records[0].balances.authorized_to_maintain_liabilities // "0"')"
  unauthorized="$(echo "$stats" | jq -r '._embedded.records[0].balances.unauthorized // "0"')"
  # Horizon reports these as decimal strings at 7 decimals ("150.0000000");
  # convert to stroops with jq's own arithmetic, not bash integer math.
  jq -n --arg a "$authorized" --arg m "$maintain" --arg u "$unauthorized" \
    '(($a|tonumber) + ($m|tonumber) + ($u|tonumber)) * 10000000 | round'
}

LIQUIDITY="500000000"        # 50 units at SCALE 1e7. SAMPLE (see header).

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

# -- [2/6] Issue the holder some DEMOUSD, ONCE ------------------------
#
# Review finding (this session): an earlier version of this script
# minted on every run with no "already done" check, unlike every
# other step here. Running the script twice (once after a transient
# RPC timeout, once to retry) silently minted TWICE, corrupting the
# holder's own real balance relative to what the rest of the script
# assumed. Guarded now: mint only if the holder's real balance (read
# from the chain, not assumed) is still zero.

log "[2/6] DEMOUSD balance for $HOLDER_ADDR"
holder_balance_before="$("$STELLAR_BIN" contract invoke --id "$DEMO_ID" --source-account "$DEMO_ISSUER" \
  --network testnet --send=no -- balance --id "$HOLDER_ADDR" 2>&1)"
if [[ "$holder_balance_before" =~ ^[0-9]+$ ]] && (( holder_balance_before > 0 )); then
  log "$HOLDER_ADDR already holds $holder_balance_before stroops of DEMOUSD; not minting again"
else
  HOLDER_BALANCE=1000000000   # 100 units at SCALE 1e7, arbitrary plausible size, enough to partially clawback.
  log "Issuing $HOLDER_BALANCE DEMOUSD to $HOLDER_ADDR"
  "$STELLAR_BIN" contract invoke --id "$DEMO_ID" --source-account "$DEMO_ISSUER" \
    --network testnet -- mint --to "$HOLDER_ADDR" --amount "$HOLDER_BALANCE" >/dev/null
  log "minted $HOLDER_BALANCE DEMOUSD to $HOLDER_ADDR"
fi

# -- [3/6] Backfill plain DEMOUSD history (oldest first) -------------
#
# No real issuer action in these hours: just the REAL current supply
# (read fresh per post, since mint/clawback can change it between
# posts) and a SAMPLE liquidity figure, so check_issuer_freeze's own
# latest_supply has something real to read even on the triggering
# epoch itself (clawback_sum / latest_supply).

log "[3/6] Backfilling $BACKFILL_HOURS hour(s) of plain DEMOUSD history"
NOW="$(date +%s)"
NEWEST_CLOSED=$(( NOW / EPOCH_SECS - 1 ))
FIRST_EPOCH=$(( NEWEST_CLOSED - BACKFILL_HOURS ))   # Leaves the newest closed hour for the triggering post itself.

for (( epoch = FIRST_EPOCH; epoch < NEWEST_CLOSED; epoch++ )); do
  supply_now="$(read_real_supply)"
  inputs_hash="$(printf 'demo-asset-backfill:%s:%s' "$epoch" "$supply_now" | shasum -a 256 | cut -d' ' -f1)"
  signal_set="{\"epoch\":$epoch,\"posted_at\":0,\"peg_ratio\":\"10000000\",\"peg_ratio_p10\":\"9998000\",\"liquidity_2pct\":\"$LIQUIDITY\",\"redemption_net\":\"0\",\"supply\":\"$supply_now\",\"supply_change_bps\":0,\"issuer_actions\":{\"clawbacks\":0,\"clawback_amount\":\"0\",\"auth_revocations\":0,\"flag_changes\":0},\"endpoint\":\"Unknown\",\"inputs_hash\":\"$inputs_hash\",\"poster\":\"$KEEPER_ADDR\"}"
  if ! post_out="$("$STELLAR_BIN" contract invoke --id "$RO_ID" --source-account sylox-testnet-keeper --network testnet -- \
    post_signals --keeper "$KEEPER_ADDR" --asset "$DEMO_ID" --s "$signal_set" 2>&1)"; then
    if [[ "$post_out" == *"Error(Contract, #103)"* ]]; then
      log "epoch $epoch already posted; skipping"
      continue
    fi
    die "post_signals(DEMOUSD, $epoch) failed:
$post_out"
  fi
  log "epoch $epoch posted (plain history, real supply=$supply_now)"
done

# -- [4/6] The real revocation and clawback --------------------------
#
# Real on-chain transactions against the holder's own trustline, from
# the issuer: this is what makes the event genuine, not a posted
# claim. CLAWBACK_ENABLED was set on the issuer BEFORE this trustline
# was opened in step 1 (deploy/demo-asset.sh's own step 2, a Stellar
# protocol requirement, not a Sylox one), so the clawback below is
# valid. CLAWBACK_REQUEST is what this script ASKS to claw back
# (bounded by the holder's own real balance, read above); the amount
# actually posted in step 5 is read back from the transaction's own
# Horizon effects, not this requested figure, in case the two ever
# differ (they should not, for a single whole clawback, but the posted
# number must be the real one regardless).

holder_balance_now="$("$STELLAR_BIN" contract invoke --id "$DEMO_ID" --source-account "$DEMO_ISSUER" \
  --network testnet --send=no -- balance --id "$HOLDER_ADDR" 2>&1)"
[[ "$holder_balance_now" =~ ^[0-9]+$ ]] || die "could not read $HOLDER_ADDR's real DEMOUSD balance: $holder_balance_now"
CLAWBACK_REQUEST=$(( holder_balance_now / 2 ))   # Half of whatever the holder really holds right now.
(( CLAWBACK_REQUEST > 0 )) || die "$HOLDER_ADDR holds $holder_balance_now stroops of DEMOUSD; nothing to claw back"

log "[4/6] Revoking $HOLDER_ADDR's authorization for $DEMO_CODE"
if ! revoke_out="$("$STELLAR_BIN" tx new set-trustline-flags --source-account "$DEMO_ISSUER" --network testnet \
  --trustor "$HOLDER_ADDR" --asset "$DEMO_CODE:$DEMO_ISSUER_ADDR" --clear-authorize 2>&1)"; then
  die "revoking $HOLDER_ADDR's authorization failed:
$revoke_out"
fi
echo "$revoke_out"
REVOKE_TX_HASH="$(echo "$revoke_out" | grep -oE '[a-f0-9]{64}' | head -1)"
log "revocation transaction: $REVOKE_TX_HASH"

log "Clawing back $CLAWBACK_REQUEST (of $holder_balance_now held) from $HOLDER_ADDR"
if ! clawback_out="$("$STELLAR_BIN" tx new clawback --source-account "$DEMO_ISSUER" --network testnet \
  --from "$HOLDER_ADDR" --asset "$DEMO_CODE:$DEMO_ISSUER_ADDR" --amount "$CLAWBACK_REQUEST" 2>&1)"; then
  die "clawback from $HOLDER_ADDR failed:
$clawback_out"
fi
echo "$clawback_out"
CLAWBACK_TX_HASH="$(echo "$clawback_out" | grep -oE '[a-f0-9]{64}' | head -1)"
log "clawback transaction: $CLAWBACK_TX_HASH"

# Read the REAL amount moved from Horizon's own effects for this
# transaction, not CLAWBACK_REQUEST: that is what was asked for, this
# is what the chain actually recorded.
clawback_effects="$(curl -sSf "$HORIZON_URL/transactions/$CLAWBACK_TX_HASH/effects" 2>&1)" \
  || die "could not read clawback transaction's effects from Horizon: $clawback_effects"
CLAWBACK_AMOUNT_DECIMAL="$(echo "$clawback_effects" | jq -r '._embedded.records[] | select(.type == "account_debited") | .amount' | head -1)"
[[ -n "$CLAWBACK_AMOUNT_DECIMAL" && "$CLAWBACK_AMOUNT_DECIMAL" != "null" ]] || die "could not find the clawback's own account_debited effect for $CLAWBACK_TX_HASH"
CLAWBACK_AMOUNT="$(jq -n --arg d "$CLAWBACK_AMOUNT_DECIMAL" '($d|tonumber) * 10000000 | round')"
log "real clawback amount, from Horizon's own effects: $CLAWBACK_AMOUNT_DECIMAL $DEMO_CODE ($CLAWBACK_AMOUNT stroops)"

# -- [5/6] Refuse to post if the real numbers would not actually trigger --
#
# Review finding (this session): this is the check that makes the
# earlier SUPPLY bug impossible to repeat silently. Mirrors
# check_issuer_freeze's own clawback_amount * 10000 / supply >=
# freeze_pct_bps check (contracts/event-registry/src/lib.rs) exactly,
# including its integer division, against the CURRENT canonical
# IssuerFreeze definition and the REAL supply at posting time.

CANONICAL_VERSION="$("$STELLAR_BIN" contract invoke --id "$ER_ID" --source-account sylox-testnet-admin --network testnet --send=no -- current_version --asset "$DEMO_ID" --kind '"IssuerFreeze"' 2>&1)"
[[ "$CANONICAL_VERSION" =~ ^[1-9][0-9]*$ ]] || die "current_version(DEMOUSD, IssuerFreeze) is not registered ($CANONICAL_VERSION); run deploy/demo-asset.sh testnet first"
def_json="$("$STELLAR_BIN" contract invoke --id "$ER_ID" --source-account sylox-testnet-admin --network testnet --send=no -- definition --asset "$DEMO_ID" --kind '"IssuerFreeze"' --version "$CANONICAL_VERSION" 2>&1)"
FREEZE_PCT_BPS="$(echo "$def_json" | jq -r '.freeze_pct_bps')"

supply_at_trigger="$(read_real_supply)"
(( supply_at_trigger > 0 )) || die "DEMOUSD's real supply read as 0; cannot check the freeze threshold against it"
bps_reached=$(( CLAWBACK_AMOUNT * 10000 / supply_at_trigger ))
log "[5/6] Check: clawback_amount * 10000 / supply = $CLAWBACK_AMOUNT * 10000 / $supply_at_trigger = $bps_reached bps (threshold: freeze_pct_bps=$FREEZE_PCT_BPS)"
if (( bps_reached < FREEZE_PCT_BPS )); then
  die "the real clawback ($CLAWBACK_AMOUNT stroops) against the real supply ($supply_at_trigger stroops) is only $bps_reached bps, below freeze_pct_bps=$FREEZE_PCT_BPS. Refusing to post a signal that would not actually pass check_issuer_freeze. The revocation and clawback above already happened on-chain and cannot be undone by this script; adjust the holder's balance or claw back a larger share before posting, or accept that this asset's real numbers do not clear the registered threshold."
fi
log "Real numbers clear the threshold ($bps_reached >= $FREEZE_PCT_BPS bps); posting the triggering signal."

# -- [6/6] Post the triggering signal, with the real tx hashes --------
#
# The keeper posts THIS hour's signal set with issuer_actions showing
# exactly the revocation and the REAL clawback amount (read in step 4,
# not requested), the REAL supply at this moment (step 5), and the
# real transaction hashes folded into the inputs the keeper hashes
# (inputs_hash), so anyone can check the posted numbers against the
# chain.

log "[6/6] Posting the triggering signal for hour $NEWEST_CLOSED"
inputs_json=$(jq -nc \
  --arg epoch "$NEWEST_CLOSED" \
  --arg clawback_amount "$CLAWBACK_AMOUNT" \
  --arg supply "$supply_at_trigger" \
  --arg revoke_tx "$REVOKE_TX_HASH" \
  --arg clawback_tx "$CLAWBACK_TX_HASH" \
  '{epoch: ($epoch|tonumber), clawback_amount: ($clawback_amount|tonumber), supply: ($supply|tonumber), auth_revocations: 1, revoke_tx_hash: $revoke_tx, clawback_tx_hash: $clawback_tx}')
inputs_hash="$(printf '%s' "$inputs_json" | shasum -a 256 | cut -d' ' -f1)"
signal_set="{\"epoch\":$NEWEST_CLOSED,\"posted_at\":0,\"peg_ratio\":\"10000000\",\"peg_ratio_p10\":\"9998000\",\"liquidity_2pct\":\"$LIQUIDITY\",\"redemption_net\":\"0\",\"supply\":\"$supply_at_trigger\",\"supply_change_bps\":0,\"issuer_actions\":{\"clawbacks\":1,\"clawback_amount\":\"$CLAWBACK_AMOUNT\",\"auth_revocations\":1,\"flag_changes\":0},\"endpoint\":\"Unknown\",\"inputs_hash\":\"$inputs_hash\",\"poster\":\"$KEEPER_ADDR\"}"
if ! trigger_out="$("$STELLAR_BIN" contract invoke --id "$RO_ID" --source-account sylox-testnet-keeper --network testnet -- \
  post_signals --keeper "$KEEPER_ADDR" --asset "$DEMO_ID" --s "$signal_set" 2>&1)"; then
  die "post_signals(DEMOUSD, $NEWEST_CLOSED, the triggering signal) failed:
$trigger_out"
fi
echo "$trigger_out"
log "triggering signal posted for epoch $NEWEST_CLOSED: clawback_amount=$CLAWBACK_AMOUNT (real), supply=$supply_at_trigger (real), auth_revocations=1"
log "inputs (with real tx hashes): $inputs_json"

PENDING_UNTIL=$(( $(date +%s) + 7200 ))
log "This signal is Pending until $(date -u -r "$PENDING_UNTIL" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$PENDING_UNTIL" +%Y-%m-%dT%H:%M:%SZ) UTC (signal_dispute_secs, 2h), then effectively Final."
log "propose_tier1 reads effectively-Final slots (ADR-008): this script does NOT wait for that; run deploy/demo-asset-propose.sh testnet once that time has passed."
