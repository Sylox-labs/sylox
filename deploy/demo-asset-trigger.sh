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
# numbers would not clear the registered threshold (step 6).
#
# Review finding (this session, a SECOND real run): the triggering
# epoch is now the real hour the revoke and clawback transactions
# actually closed in (floor(created_at/EPOCH_SECS), step 4), never
# wall-clock "now" at script-run time. The original NEWEST_CLOSED
# shortcut (floor(now/EPOCH_SECS) - 1) misdated the action: it posts
# whatever hour is "most recently closed" AT SCRIPT-RUN TIME, which
# drifts forward if the script resumes later than the actions
# themselves happened. Each issuer action belongs in the hour it
# really happened in, not the hour the script happened to be running
# in afterward.
#
# Which fields are real, which are sample:
#   - peg_ratio, peg_ratio_p10, liquidity_2pct: SAMPLE. DEMOUSD has no
#     real market to observe a peg or liquidity from; these are
#     plausible placeholder values, the same convention deploy/post-
#     demo-signals.sh uses for USDC's own synthetic backfill.
#   - supply: REAL. Read from Horizon's asset-stats endpoint
#     immediately before each post (steps 5 and 6), the actual
#     authorized + authorized_to_maintain_liabilities + unauthorized
#     balance total for DEMOUSD at that moment.
#   - supply_change_bps: REAL. Computed from the previous epoch's own
#     REAL stored supply (read via RiskOracle.signals(), not Horizon -
#     see read_previous_supply's own comment for why), using
#     check_supply_change_consistency's exact formula
#     (contracts/risk-oracle/src/lib.rs). A prior version of this
#     script hardcoded 0 here, which the contract correctly rejected
#     once the real supply genuinely moved between the gap-fill hour
#     and the triggering post (the clawback itself does that).
#   - clawback_amount, auth_revocations: REAL. The revocation and
#     clawback in step 3 are genuine Stellar operations against the
#     holder's own trustline; clawback_amount is read back from the
#     clawback transaction's own Horizon effects (the amount it
#     actually moved), never the amount requested.
#   - revoke_tx_hash, clawback_tx_hash: REAL transaction hashes,
#     stellar.expert-linkable, folded into the posted inputs so anyone
#     can check the posted numbers against the chain.
#
# Usage: deploy/demo-asset-trigger.sh testnet [backfill_hours] [--dry-run] [asset_code]
#   backfill_hours: hours of plain history to post before the gap-fill
#                   hour (step 5), oldest first. Default 3, capped at
#                   71 (same bound as post-demo-signals.sh, for the
#                   same reason).
#   --dry-run: print the resume plan (every step: "already done (tx
#              ...)" or "will submit") and exit before anything is
#              signed. Safe to run any number of times; makes no
#              on-chain calls beyond the same reads a real run would
#              make anyway.
#   asset_code: defaults to DEMOUSD, reading
#               deployments/testnet-demo-asset.json and reusing
#               sylox-demo-holder-2, exactly as before this script took
#               an asset_code argument at all. Any other code reads
#               deployments/testnet-demo-asset-<code, lowercased>.json
#               instead and gets its own holder identity
#               (sylox-demo-holder-2-<code, lowercased>), so a second
#               demo asset's holder, mint, revoke and clawback never
#               touch DEMOUSD's own holder or history.
#
# Resumable by design, not just safe to retry: every step below checks
# the REAL chain state before deciding whether to submit anything, the
# same principle steps 1/2/3's "already done" guards already used, now
# extended to the clawback too (previously the one step with no guard
# at all - see RESUME NOTE below). A rerun against today's real state
# submits nothing before the triggering post: holder exists and funded
# (step 1), already minted (step 2), already revoked and already
# clawed back (step 3, this run's fix), already backfilled and
# gap-filled (step 5, via post_signals's own #103 EpochAlreadyPosted) -
# each detected from the chain, not from a local marker file this
# script could lose or never had reason to trust over the chain
# itself.
#
# RESUME NOTE: a rerun's own CLAWBACK_REQUEST (half of whatever the
# holder holds RIGHT NOW) must never be computed, let alone submitted,
# once a real clawback already exists for this holder - doing so would
# claw back half of the REMAINING balance a second time, corrupting
# the evidence this script exists to produce. find_clawback_tx_hash
# below looks up the real, already-posted clawback from Horizon FIRST;
# only when none exists does this script compute a request amount and
# submit anything.

set -uo pipefail

NETWORK="${1:-}"
BACKFILL_HOURS="${2:-3}"
DRY_RUN=0
ASSET_CODE_ARG="DEMOUSD"
for arg in "${@:3}"; do
  if [[ "$arg" == "--dry-run" ]]; then
    DRY_RUN=1
  else
    ASSET_CODE_ARG="$arg"
  fi
done
if [[ "$NETWORK" != "testnet" ]]; then
  echo "usage: $0 testnet [backfill_hours] [--dry-run] [asset_code]" >&2
  exit 1
fi
if ! [[ "$BACKFILL_HOURS" =~ ^[0-9]+$ ]] || (( BACKFILL_HOURS < 1 || BACKFILL_HOURS > 71 )); then
  echo "backfill_hours must be an integer between 1 and 71" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RECORD="$REPO_ROOT/deployments/testnet.json"

# DEMOUSD keeps today's exact record filename and holder alias (no
# suffix); any other code gets its own suffixed filename and alias
# (lowercased, same convention as deploy/demo-asset.sh), so a second
# demo asset's holder, mint, revoke and clawback can never collide
# with DEMOUSD's own.
if [[ "$ASSET_CODE_ARG" == "DEMOUSD" ]]; then
  DEMO_RECORD="$REPO_ROOT/deployments/testnet-demo-asset.json"
  HOLDER_ALIAS_SUFFIX=""
else
  ASSET_CODE_LOWER="$(echo "$ASSET_CODE_ARG" | tr '[:upper:]' '[:lower:]')"
  DEMO_RECORD="$REPO_ROOT/deployments/testnet-demo-asset-$ASSET_CODE_LOWER.json"
  HOLDER_ALIAS_SUFFIX="-$ASSET_CODE_LOWER"
fi
[[ -f "$RECORD" ]] || { echo "FATAL: $RECORD not found; run deploy/deploy.sh testnet first" >&2; exit 1; }
[[ -f "$DEMO_RECORD" ]] || { echo "FATAL: $DEMO_RECORD not found; run deploy/demo-asset.sh testnet${HOLDER_ALIAS_SUFFIX:+ (and pass $ASSET_CODE_ARG)} first" >&2; exit 1; }

STELLAR_BIN="${STELLAR_CLI_BIN:-stellar}"
EPOCH_SECS=3600
WINDOW_SECS=259200   # contracts/risk-oracle/src/lib.rs's own WINDOW_SECS: 72 hours, the backfill reach check_epoch_window enforces.
HORIZON_URL="https://horizon-testnet.stellar.org"

RO_ID="$(jq -r '.contracts.risk_oracle.id' "$RECORD")"
ER_ID="$(jq -r '.contracts.event_registry.id' "$RECORD")"
KEEPER_ADDR="$(jq -r '.identities.keeper' "$RECORD")"
DEMO_ID="$(jq -r '.demo_asset.contract_id' "$DEMO_RECORD")"
DEMO_CODE="$(jq -r '.demo_asset.asset_code' "$DEMO_RECORD")"
DEMO_ISSUER_ADDR="$(jq -r '.demo_asset.issuer' "$DEMO_RECORD")"
DEMO_ISSUER="sylox-demo-issuer$HOLDER_ALIAS_SUFFIX"

log() { echo "==> $*"; }
die() { echo "FATAL: $*" >&2; exit 1; }

# Parses an i128 value out of `stellar contract invoke --send=no`'s
# own output, which wraps a plain integer return in literal double
# quotes (e.g. "1500000000", not 1500000000). A bare ^[0-9]+$ match
# against that raw string never matches, so a check written as "if it
# looks like a number and is > 0" silently fell through to its own
# else branch for every holder that already had a real, nonzero
# balance, treating "already funded" as "needs minting" (see
# docs/event-0-demousd-issuer-freeze.md for what that actually caused
# on this testnet). Strips one leading/trailing double quote if
# present, then requires the result to be ALL digits - never falls
# back to treating an unparseable value as zero or "skip", since
# either of those silently mints into an unknown real balance.
parse_i128() {
  local raw="$1" label="$2"
  local cleaned="${raw#\"}"
  cleaned="${cleaned%\"}"
  if [[ ! "$cleaned" =~ ^[0-9]+$ ]]; then
    die "could not parse $label as an integer (got: $raw)"
  fi
  echo "$cleaned"
}

# Runs `stellar contract invoke --send=no ...` (every argument after
# `label` passed through verbatim) and prints ONLY its stdout -
# whatever that call's own return value actually is, never mixed with
# a CLI warning on stderr. A stray stderr line (a deprecation notice,
# a retry warning) landing in the same string as the real return value
# is exactly the kind of thing that broke the quoted-i128 parsing this
# script already had to fix once; capturing them separately stops that
# class of bug from coming back through a different call site. Dies
# with the real exit status and the real stderr content (read back
# from a temp file, not re-merged into stdout) on failure, rather than
# the caller trying to parse a failure message as if it were data.
invoke_read() {
  local label="$1"
  shift
  local stderr_file out rc
  stderr_file="$(mktemp)"
  out="$("$STELLAR_BIN" contract invoke "$@" 2>"$stderr_file")"
  rc=$?
  if (( rc != 0 )); then
    local err
    err="$(cat "$stderr_file")"
    rm -f "$stderr_file"
    die "$label: stellar contract invoke failed (exit $rc): $err"
  fi
  rm -f "$stderr_file"
  echo "$out"
}

# Reads whether `trustor`'s trustline to `asset_code:asset_issuer` is
# currently authorized, straight from Horizon (not assumed from this
# script's own prior actions, which may not be the only thing that
# ever touched this trustline - e.g. a previous run of this same
# script, now treated as a legitimate prior state to detect and skip
# past, not an error). Returns "true", "false", or dies if the
# trustline cannot be found at all (a holder with no trustline yet is
# a different, earlier problem than this function is meant to check).
read_trustline_authorized() {
  local trustor="$1" asset_code="$2" asset_issuer="$3"
  local account_json
  account_json="$(curl -sSf "$HORIZON_URL/accounts/$trustor" 2>&1)" \
    || die "could not read $trustor's account from Horizon: $account_json"
  local authorized
  authorized="$(echo "$account_json" | jq -r --arg code "$asset_code" --arg issuer "$asset_issuer" \
    '.balances[] | select(.asset_code == $code and .asset_issuer == $issuer) | .is_authorized')"
  [[ -n "$authorized" && "$authorized" != "null" ]] \
    || die "$trustor has no $asset_code:$asset_issuer trustline to check authorization on"
  echo "$authorized"
}

# The jq half of find_revoke_tx_hash, factored out so it can be tested
# against small local JSON samples (deploy/test-demo-asset-trigger-
# find-revoke.sh) without a real Horizon call. Takes Horizon's own
# /accounts/{id}/operations response (already fetched) and returns the
# most recent (the list is order=desc, so [0] is newest)
# set_trust_line_flags operation that actually cleared authorization
# (clear_flags_s contains "authorized", confirmed against the real
# revoke's own operation record) for this exact trustor/asset_code
# pair, or empty if none matches. Checking clear_flags_s and not just
# the operation type matters because set_trust_line_flags is also how
# the OPPOSITE action (re-authorizing) would show up on-chain; this
# script never calls that itself, but a future admin action or a
# different script could, and the newest set_trust_line_flags
# wouldn't then be the real revoke.
select_revoke_tx_hash_from_ops() {
  local ops_json="$1" trustor="$2" asset_code="$3"
  echo "$ops_json" | jq -r --arg trustor "$trustor" --arg code "$asset_code" \
    '[._embedded.records[] | select(.type == "set_trust_line_flags" and .trustor == $trustor and .asset_code == $code and ((.clear_flags_s // []) | index("authorized")))][0].transaction_hash // empty'
}

# Finds the real transaction hash of `issuer`'s most recent
# set_trust_line_flags operation against `trustor`'s trustline to
# asset_code, straight from Horizon. Used only when
# read_trustline_authorized finds the trustline ALREADY deauthorized
# (a prior interrupted run of this script got that far before dying),
# so the evidence posted in step 6 still carries the real revoke
# transaction hash rather than an empty one. This script only ever
# calls set-trustline-flags with --clear-authorize (never a
# re-authorize), so matching on type + trustor + asset_code alone is
# unambiguous for this issuer; there is no second, opposite-direction
# set_trust_line_flags call anywhere in this codebase to confuse it
# with. Dies rather than return empty if no match is found: posting
# evidence with no revoke hash at all is worse than stopping here.
find_revoke_tx_hash() {
  local issuer_addr="$1" trustor="$2" asset_code="$3"
  local ops_json
  ops_json="$(curl -sSf "$HORIZON_URL/accounts/$issuer_addr/operations?order=desc&limit=200" 2>&1)" \
    || die "could not read $issuer_addr's operations from Horizon: $ops_json"
  local tx_hash
  tx_hash="$(select_revoke_tx_hash_from_ops "$ops_json" "$trustor" "$asset_code")"
  [[ -n "$tx_hash" ]] \
    || die "could not find a set_trust_line_flags operation against $trustor's $asset_code trustline in $issuer_addr's last 200 operations; the trustline reads deauthorized but its own revoke transaction cannot be located"
  echo "$tx_hash"
}

# The jq half of find_clawback_tx_hash, factored out the same way
# select_revoke_tx_hash_from_ops is (tested against local JSON samples
# in deploy/test-demo-asset-trigger-find-clawback.sh, no real Horizon
# call). A clawback operation's holder-identifying field is `from`,
# not `trustor` (confirmed against the real clawback operation's own
# Horizon record: trustor is null, from is the holder) - a clawback
# is not a trustline operation, so it has no trustor field at all.
select_clawback_tx_hash_from_ops() {
  local ops_json="$1" holder="$2" asset_code="$3"
  echo "$ops_json" | jq -r --arg holder "$holder" --arg code "$asset_code" \
    '[._embedded.records[] | select(.type == "clawback" and .from == $holder and .asset_code == $code)][0].transaction_hash // empty'
}

# Finds the real transaction hash AND real amount of `issuer`'s most
# recent clawback operation against `holder`'s asset_code balance,
# straight from Horizon. Used to detect "this holder already had a
# real clawback" BEFORE this script computes or submits a new one -
# see this file's own RESUME NOTE in its header for why that ordering
# matters. Returns empty (not a die) when no match is found: unlike a
# missing revoke (which read_trustline_authorized's own state check
# already proved must exist once the trustline reads deauthorized),
# "no clawback yet" is the normal, expected state for the first real
# run and must not be treated as an error here.
find_clawback_tx_hash() {
  local issuer_addr="$1" holder="$2" asset_code="$3"
  local ops_json
  ops_json="$(curl -sSf "$HORIZON_URL/accounts/$issuer_addr/operations?order=desc&limit=200" 2>&1)" \
    || die "could not read $issuer_addr's operations from Horizon: $ops_json"
  select_clawback_tx_hash_from_ops "$ops_json" "$holder" "$asset_code"
}

# Real amount moved by a clawback transaction, in stroops, read from
# ITS OWN account_debited effect - the same technique this script
# already uses right after submitting a new clawback (step 4), now
# shared so a resumed run reads the SAME real number from a PRIOR
# run's clawback instead of recomputing anything.
read_clawback_amount_stroops() {
  local tx_hash="$1"
  local effects decimal
  effects="$(curl -sSf "$HORIZON_URL/transactions/$tx_hash/effects" 2>&1)" \
    || die "could not read clawback transaction's effects from Horizon: $effects"
  decimal="$(echo "$effects" | jq -r '._embedded.records[] | select(.type == "account_debited") | .amount' | head -1)"
  [[ -n "$decimal" && "$decimal" != "null" ]] || die "could not find the clawback's own account_debited effect for $tx_hash"
  jq -n --arg d "$decimal" '($d|tonumber) * 10000000 | round'
}

# The pure conversion half of read_tx_epoch, factored out so it can be
# tested against real ISO-8601 timestamps (deploy/test-demo-asset-
# trigger-read-tx-epoch.sh) without a real Horizon call. date -u -d
# (GNU) first, date -u -j -f (BSD) as fallback - same portable pattern
# deploy/post-demo-signals.sh already uses for the reverse direction.
created_at_to_epoch() {
  local created_at="$1"
  local ts
  ts="$(date -u -d "$created_at" +%s 2>/dev/null \
    || date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$created_at" +%s 2>/dev/null)"
  [[ "$ts" =~ ^[0-9]+$ ]] || die "could not parse created_at ($created_at) as a date"
  echo $(( ts / EPOCH_SECS ))
}

# The epoch an issuer action's own transaction actually closed in:
# floor(created_at / EPOCH_SECS), read from Horizon's own created_at
# for that transaction - never the wall clock at the moment this
# script happens to run. Review finding (this session, a real run):
# the original NEWEST_CLOSED (floor(now/EPOCH_SECS) - 1) posted the
# revoke and clawback under whatever hour was "the most recently
# closed" AT SCRIPT-RUN TIME, which can be a different, later hour
# than the one the actions actually happened in if the script resumes
# after a gap (exactly what happened here - run interrupted close to
# a new hour starting (clawback at 21:14:02, 497709), the resumed dry
# run's own current hour had already rolled forward by the time this
# was written).
read_tx_epoch() {
  local tx_hash="$1"
  local tx_json created_at
  tx_json="$(curl -sSf "$HORIZON_URL/transactions/$tx_hash" 2>&1)" \
    || die "could not read transaction $tx_hash from Horizon: $tx_json"
  created_at="$(echo "$tx_json" | jq -r '.created_at')"
  [[ -n "$created_at" && "$created_at" != "null" ]] || die "transaction $tx_hash has no created_at"
  created_at_to_epoch "$created_at"
}

# Real circulating supply for DEMOUSD, in stroops (SCALE 1e7), read
# fresh from Horizon every time it's needed: authorized +
# authorized_to_maintain_liabilities + unauthorized balances, the
# total actually issued and held outside the issuer account (the
# issuer's own SAC balance always reads as effectively unlimited, not
# a real supply figure).
read_real_supply() {
  local stats
  stats="$(curl -sSf "$HORIZON_URL/assets?asset_code=$DEMO_CODE&asset_issuer=$DEMO_ISSUER_ADDR" 2>&1)" \
    || die "could not read $DEMO_CODE's asset stats from Horizon: $stats"
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

# Reads epoch - 1's own REAL stored supply via RiskOracle.signals(),
# not Horizon: check_supply_change_consistency (contracts/risk-oracle/
# src/lib.rs) compares against storage::get_slot's own previous ring
# slot, i.e. what THIS asset's own prior post actually recorded, not
# whatever Horizon reports right now (which can have moved again by
# posting time, exactly what happened here: the clawback drops the
# real Horizon supply AFTER the backfill already posted a higher
# figure for the prior epoch). Echoes empty, not 0 and not a die, when
# there is no prior slot (epoch 0, or a gap) - epoch 0's own
# unconditional pass and the "no previous slot" unconditional pass in
# check_supply_change_consistency are exactly the two cases
# compute_supply_change_bps below also treats as "no check, 0 is
# correct by definition", so empty here must mean 0 there, not an
# error.
read_previous_supply() {
  local epoch="$1"
  if (( epoch == 0 )); then
    echo ""
    return
  fi
  local previous_epoch=$(( epoch - 1 ))
  local out
  out="$(invoke_read "signals($DEMO_CODE, $previous_epoch)" --id "$RO_ID" --source-account "$DEMO_ISSUER" \
    --network testnet --send=no -- signals --asset "$DEMO_ID" --epoch "$previous_epoch")"
  if [[ "$out" == "null" ]]; then
    echo ""
    return
  fi
  echo "$out" | jq -r '.supply'
}

# Copies check_supply_change_consistency's own formula exactly
# (contracts/risk-oracle/src/lib.rs): ((supply - previous.supply) *
# 10_000) / previous.supply, i128 division truncating toward zero -
# confirmed this matches bash's own `$(( ))` integer division
# (verified by hand: $(( -7 / 2 )) is -3, the same truncate-toward-
# zero Rust's i128 division uses, not Python's floor -4). Returns "0"
# when there is no previous slot to compare against (read_
# previous_supply returns empty for epoch 0 or a missing prior post) -
# the contract's own two unconditional-pass cases, where ANY posted
# supply_change_bps is accepted, so posting the true, unconstrained
# value of 0 is correct, not a placeholder.
compute_supply_change_bps() {
  local supply="$1" previous_supply="$2"
  if [[ -z "$previous_supply" ]]; then
    echo "0"
    return
  fi
  (( previous_supply != 0 )) || { echo "0"; return; }   # Same zero-previous-supply skip check_supply_change_consistency itself makes.
  echo $(( (supply - previous_supply) * 10000 / previous_supply ))
}

# -- [1/7] Holder identity and trustline -----------------------------
#
# sylox-demo-holder-2, not the original sylox-demo-holder: that first
# holder's own trustline is permanently deauthorized (the real event-0
# revocation, see docs/event-0-demousd-issuer-freeze.md) with 150
# DEMOUSD of real clawback-eligible balance still on it. Reusing it
# here would either collide with read_trustline_authorized's own
# unexpected-state check below (it is neither "authorized" nor the
# pre-change-trust "none" case this script expects at a fresh start)
# or, worse, mint a second batch on top of an already-event-marked
# holder. This script's own header already says a reset means a fresh
# holder, not a re-run against the same one.

# plan() prints one line of the dry-run/resume plan, in the exact
# format the PR's own dry-run evidence uses: "already done (tx ...)"
# or "will submit (...)". Always printed, dry-run or not, so a real
# run's own log carries the same plan a --dry-run would have shown,
# right before actually doing it. Also records each label's own
# status, so note_submission (below) can check a step's plan against
# what it actually did.
declare -A PLAN_STATUS_BY_LABEL=()
plan() {
  local label="$1" status="$2" detail="${3:-}"
  PLAN_STATUS_BY_LABEL["$label"]="$status"
  if [[ -n "$detail" ]]; then
    log "[plan] $label: $status ($detail)"
  else
    log "[plan] $label: $status"
  fi
}

# One gate per step (review finding - a real run caught a step that
# submitted a real transaction after its own plan line said "already
# done"): every real submission in this script calls note_submission
# right after it lands, naming the exact label plan() was just called
# with for that same step. Dies immediately if that label's most
# recent plan status was NOT "will submit" - this is the guard that
# makes the one-gate-per-step rule a checked invariant, not just a
# convention later code has to remember to follow. Also the single
# place every submitted transaction hash is collected
# (SUBMITTED_TX_HASHES), so the final report never has to go back to
# Horizon to find a hash this run's own output already had.
declare -A SUBMITTED_TX_HASHES=()
note_submission() {
  local label="$1" tx_hash="$2"
  local status="${PLAN_STATUS_BY_LABEL[$label]:-}"
  [[ "$status" == "will submit" ]] \
    || die "INTERNAL: $label just submitted a real transaction ($tx_hash), but its own plan said \"$status\", not \"will submit\". This should never happen; stopping before anything else runs so this can be investigated rather than silently repeated."
  [[ -n "$tx_hash" ]] \
    || die "INTERNAL: $label submitted a real transaction but no hash was captured for it"
  SUBMITTED_TX_HASHES["$label"]="$tx_hash"
}

log "[1/7] $DEMO_CODE holder identity"
HOLDER="sylox-demo-holder-2$HOLDER_ALIAS_SUFFIX"
HOLDER_EXISTS=0
"$STELLAR_BIN" keys address "$HOLDER" >/dev/null 2>&1 && HOLDER_EXISTS=1

if (( HOLDER_EXISTS )); then
  plan "holder identity ($HOLDER)" "already done" "$("$STELLAR_BIN" keys address "$HOLDER")"
else
  plan "holder identity ($HOLDER)" "will submit" "friendbot funding"
  (( DRY_RUN )) || { "$STELLAR_BIN" keys generate "$HOLDER" --network testnet --fund; log "identity $HOLDER created and funded"; }
fi
# In dry-run, a holder that does not exist yet has no address to check
# a trustline against - every check from here on on an as-yet-
# nonexistent holder reports "cannot check yet", not a false "will
# submit", since this script genuinely cannot know a fresh holder's
# eventual trustline/balance/clawback state before it exists.
HOLDER_ADDR="$("$STELLAR_BIN" keys address "$HOLDER" 2>/dev/null || true)"
if [[ -z "$HOLDER_ADDR" ]]; then
  (( DRY_RUN )) || die "could not read $HOLDER's address after creating it"
fi

if [[ -n "$HOLDER_ADDR" ]]; then
  # Persisted so anything outside this script's own local CLI identity
  # store (deploy/extend-ttl.sh, run from a container that never
  # created or imported "sylox-demo-holder-2") can still find the
  # holder's address without deriving it from the identity itself.
  # Skipped in dry-run: writing this file is a local side effect a
  # dry-run should not perform either.
  if (( ! DRY_RUN )); then
    tmp_demo_record="$(mktemp)"
    jq --arg holder "$HOLDER_ADDR" '.demo_asset.holder = $holder' "$DEMO_RECORD" > "$tmp_demo_record"
    mv "$tmp_demo_record" "$DEMO_RECORD"
  fi

  # One gate per step (review finding - a real run): this used to
  # compute HOLDER_TRUSTLINE_EXISTS only to choose the PLAN line's
  # wording, then run change-trust unconditionally whenever
  # ! DRY_RUN - so a real run submitted change-trust even when the
  # plan, printed moments earlier, said "already done". Confirmed
  # harmless in the real run that caught this (a repeat change-trust
  # to an already-open trustline with the same limit and flags is a
  # genuine Stellar no-op; the trustline's own authorization state was
  # unchanged before and after), but it is still a real signed
  # transaction the plan did not predict. Every step now decides ONCE
  # whether it is done, in an if/else whose "will submit" branch is
  # the ONLY place that submits - dry-run and real mode share that
  # same branch, gated only by DRY_RUN inside it, the same shape every
  # other step in this script already uses.
  # A failed Horizon lookup here must never read as "no trustline" -
  # review finding: curl -sSf ... || account_json_step1="" treated a
  # network failure exactly like a genuine "trustline does not exist
  # yet" and would have submitted change-trust either way. die on a
  # real lookup failure instead, the same pattern every other Horizon
  # read in this script already uses - this was the one exception.
  HOLDER_TRUSTLINE_EXISTS=0
  account_json_step1="$(curl -sSf "$HORIZON_URL/accounts/$HOLDER_ADDR" 2>&1)" \
    || die "could not read $HOLDER_ADDR's account from Horizon: $account_json_step1"
  if echo "$account_json_step1" | jq -e --arg code "$DEMO_CODE" --arg issuer "$DEMO_ISSUER_ADDR" \
      '.balances[]? | select(.asset_code == $code and .asset_issuer == $issuer)' >/dev/null 2>&1; then
    HOLDER_TRUSTLINE_EXISTS=1
  fi
  if (( HOLDER_TRUSTLINE_EXISTS )); then
    plan "trustline ($DEMO_CODE)" "already done"
  else
    plan "trustline ($DEMO_CODE)" "will submit" "change-trust"
    if (( ! DRY_RUN )); then
      log "Opening $HOLDER's trustline to $DEMO_CODE:$DEMO_ISSUER_ADDR"
      trust_out="$("$STELLAR_BIN" tx new change-trust --source-account "$HOLDER" \
        --line "$DEMO_CODE:$DEMO_ISSUER_ADDR" --network testnet 2>&1)" || die "opening $HOLDER's trustline failed:
$trust_out"
      echo "$trust_out"
      TRUSTLINE_TX_HASH="$(echo "$trust_out" | grep -oE '[a-f0-9]{64}' | head -1)"
      log "trustline transaction: $TRUSTLINE_TX_HASH"
      note_submission "trustline ($DEMO_CODE)" "$TRUSTLINE_TX_HASH"
    fi
  fi
else
  plan "trustline ($DEMO_CODE)" "cannot check yet" "holder identity does not exist locally"
fi

# -- [2/7] Issue the holder some DEMOUSD, ONCE ------------------------
#
# Review finding (this session): an earlier version of this script
# minted on every run with no "already done" check, unlike every
# other step here. Running the script twice (once after a transient
# RPC timeout, once to retry) silently minted TWICE, corrupting the
# holder's own real balance relative to what the rest of the script
# assumed. Guarded now: mint only if the holder's real balance (read
# from the chain, not assumed) is still zero.

log "[2/7] $DEMO_CODE balance for $HOLDER_ADDR"
if [[ -z "$HOLDER_ADDR" ]]; then
  plan "mint" "cannot check yet" "holder identity does not exist locally"
else
  holder_balance_before_raw="$(invoke_read "$HOLDER_ADDR's $DEMO_CODE balance" --id "$DEMO_ID" --source-account "$DEMO_ISSUER" \
    --network testnet --send=no -- balance --id "$HOLDER_ADDR")"
  holder_balance_before="$(parse_i128 "$holder_balance_before_raw" "$HOLDER_ADDR's $DEMO_CODE balance")"
  if (( holder_balance_before > 0 )); then
    plan "mint" "already done" "$holder_balance_before stroops already held"
    log "$HOLDER_ADDR already holds $holder_balance_before stroops of $DEMO_CODE; not minting again"
  else
    plan "mint" "will submit" "1000000000 stroops"
    if (( ! DRY_RUN )); then
      HOLDER_BALANCE=1000000000   # 100 units at SCALE 1e7, arbitrary plausible size, enough to partially clawback.
      log "Issuing $HOLDER_BALANCE $DEMO_CODE to $HOLDER_ADDR"
      mint_out="$("$STELLAR_BIN" contract invoke --id "$DEMO_ID" --source-account "$DEMO_ISSUER" \
        --network testnet -- mint --to "$HOLDER_ADDR" --amount "$HOLDER_BALANCE" 2>&1)" || die "minting to $HOLDER_ADDR failed:
$mint_out"
      echo "$mint_out"
      MINT_TX_HASH="$(echo "$mint_out" | grep -oE '[a-f0-9]{64}' | head -1)"
      log "minted $HOLDER_BALANCE $DEMO_CODE to $HOLDER_ADDR: $MINT_TX_HASH"
      note_submission "mint" "$MINT_TX_HASH"
    fi
  fi
fi

# -- [3/7] The real revocation and clawback --------------------------
#
# Real on-chain transactions against the holder's own trustline, from
# the issuer: this is what makes the event genuine, not a posted
# claim. CLAWBACK_ENABLED was set on the issuer BEFORE this trustline
# was opened in step 1 (deploy/demo-asset.sh's own step 2, a Stellar
# protocol requirement, not a Sylox one), so the clawback below is
# valid. CLAWBACK_REQUEST is what this script ASKS to claw back
# (bounded by the holder's own real balance, read above); the amount
# actually posted in step 7 is read back from the transaction's own
# Horizon effects, not this requested figure, in case the two ever
# differ (they should not, for a single whole clawback, but the posted
# number must be the real one regardless).
#
# Moved ahead of the backfill (previously step 3, now step 5): the
# backfill's own range now depends on TRIGGER_EPOCH (step 4), which in
# turn depends on these two transactions actually existing.

log "[3/7] Revoking $HOLDER_ADDR's authorization for $DEMO_CODE"
if [[ -z "$HOLDER_ADDR" ]]; then
  plan "revoke" "cannot check yet" "holder identity does not exist locally"
  plan "clawback" "cannot check yet" "holder identity does not exist locally"
else
  # Checked by real state, not assumed: a fresh holder's trustline
  # reads "true" here (change-trust alone does not revoke anything);
  # only a PRIOR run of this same script (interrupted after revoking
  # but before the clawback) would ever find "false" already. Either
  # is a known, safe-to-continue state; anything else (e.g. the
  # account not holding this trustline at all) is a real problem, not
  # something to paper over by calling set-trustline-flags regardless.
  already_authorized="$(read_trustline_authorized "$HOLDER_ADDR" "$DEMO_CODE" "$DEMO_ISSUER_ADDR")"
  case "$already_authorized" in
    true)
      plan "revoke" "will submit"
      if (( ! DRY_RUN )); then
        if ! revoke_out="$("$STELLAR_BIN" tx new set-trustline-flags --source-account "$DEMO_ISSUER" --network testnet \
          --trustor "$HOLDER_ADDR" --asset "$DEMO_CODE:$DEMO_ISSUER_ADDR" --clear-authorize 2>&1)"; then
          die "revoking $HOLDER_ADDR's authorization failed:
$revoke_out"
        fi
        echo "$revoke_out"
        REVOKE_TX_HASH="$(echo "$revoke_out" | grep -oE '[a-f0-9]{64}' | head -1)"
        log "revocation transaction: $REVOKE_TX_HASH"
        note_submission "revoke" "$REVOKE_TX_HASH"
      fi
      ;;
    false)
      REVOKE_TX_HASH="$(find_revoke_tx_hash "$DEMO_ISSUER_ADDR" "$HOLDER_ADDR" "$DEMO_CODE")"
      plan "revoke" "already done" "$REVOKE_TX_HASH"
      log "$HOLDER_ADDR's trustline is already deauthorized (a prior run of this script got this far); not revoking again"
      log "found the real revoke transaction from a prior run: $REVOKE_TX_HASH"
      ;;
    *)
      die "$HOLDER_ADDR's $DEMO_CODE trustline authorization read as an unexpected value: $already_authorized"
      ;;
  esac

  # RESUME NOTE (this file's own header): checked BEFORE computing any
  # clawback request amount, not after - a rerun's own "half of
  # whatever the holder holds right now" must never even be computed
  # once a real clawback already exists, since the holder's current
  # balance already reflects that prior clawback and halving it again
  # would be a SECOND real clawback, not a no-op. find_clawback_tx_hash
  # returns empty (not a die) when none exists - that is the normal,
  # expected state on a genuinely first run.
  EXISTING_CLAWBACK_TX_HASH="$(find_clawback_tx_hash "$DEMO_ISSUER_ADDR" "$HOLDER_ADDR" "$DEMO_CODE")"
  if [[ -n "$EXISTING_CLAWBACK_TX_HASH" ]]; then
    CLAWBACK_TX_HASH="$EXISTING_CLAWBACK_TX_HASH"
    CLAWBACK_AMOUNT="$(read_clawback_amount_stroops "$CLAWBACK_TX_HASH")"
    plan "clawback" "already done" "$CLAWBACK_TX_HASH, $CLAWBACK_AMOUNT stroops"
    log "$HOLDER_ADDR already has a real clawback from a prior run; not clawing back again"
    log "found the real clawback transaction from a prior run: $CLAWBACK_TX_HASH ($CLAWBACK_AMOUNT stroops)"
  else
    holder_balance_now_raw="$(invoke_read "$HOLDER_ADDR's real $DEMO_CODE balance" --id "$DEMO_ID" --source-account "$DEMO_ISSUER" \
      --network testnet --send=no -- balance --id "$HOLDER_ADDR")"
    holder_balance_now="$(parse_i128 "$holder_balance_now_raw" "$HOLDER_ADDR's real $DEMO_CODE balance")"
    CLAWBACK_REQUEST=$(( holder_balance_now / 2 ))   # Half of whatever the holder really holds right now.
    (( CLAWBACK_REQUEST > 0 )) || die "$HOLDER_ADDR holds $holder_balance_now stroops of $DEMO_CODE; nothing to claw back"
    plan "clawback" "will submit" "$CLAWBACK_REQUEST of $holder_balance_now stroops held"

    if (( ! DRY_RUN )); then
      log "Clawing back $CLAWBACK_REQUEST (of $holder_balance_now held) from $HOLDER_ADDR"
      if ! clawback_out="$("$STELLAR_BIN" tx new clawback --source-account "$DEMO_ISSUER" --network testnet \
        --from "$HOLDER_ADDR" --asset "$DEMO_CODE:$DEMO_ISSUER_ADDR" --amount "$CLAWBACK_REQUEST" 2>&1)"; then
        die "clawback from $HOLDER_ADDR failed:
$clawback_out"
      fi
      echo "$clawback_out"
      CLAWBACK_TX_HASH="$(echo "$clawback_out" | grep -oE '[a-f0-9]{64}' | head -1)"
      log "clawback transaction: $CLAWBACK_TX_HASH"
      note_submission "clawback" "$CLAWBACK_TX_HASH"

      # Read the REAL amount moved from Horizon's own effects for this
      # transaction, not CLAWBACK_REQUEST: that is what was asked for,
      # this is what the chain actually recorded.
      CLAWBACK_AMOUNT="$(read_clawback_amount_stroops "$CLAWBACK_TX_HASH")"
      log "real clawback amount, from Horizon's own effects: $CLAWBACK_AMOUNT stroops"
    fi
  fi
fi

# -- [4/7] Derive the triggering epoch from the real actions ---------
#
# Review finding (this session, a real run): the original
# NEWEST_CLOSED (floor(now/EPOCH_SECS) - 1) posted under whatever hour
# was "the most recently closed" AT SCRIPT-RUN TIME, not the hour the
# revoke and clawback actually happened in. Each issuer action is
# posted in the hour its OWN transaction closed in
# (floor(created_at/EPOCH_SECS)), once that hour has actually closed -
# never the hour before it, and never wall-clock "now". If a rerun
# happens well after the actions (e.g. this script resumes the next
# day), TRIGGER_EPOCH still pins to when the actions really happened,
# not to whatever hour is current when this runs.
#
# The revoke and clawback must agree on their own hour: this script
# posts ONE signal_set for both actions together, so if they
# genuinely straddled an hour boundary, there is no single epoch that
# correctly represents both and this script has no business guessing
# which one to use.

if [[ -z "${REVOKE_TX_HASH:-}" || -z "${CLAWBACK_TX_HASH:-}" ]]; then
  log "[4/7] Cannot derive the triggering epoch yet: holder identity does not exist locally (dry run on a fresh setup)"
  TRIGGER_EPOCH=""
else
  revoke_epoch="$(read_tx_epoch "$REVOKE_TX_HASH")"
  clawback_epoch="$(read_tx_epoch "$CLAWBACK_TX_HASH")"
  if [[ "$revoke_epoch" != "$clawback_epoch" ]]; then
    die "the revoke ($REVOKE_TX_HASH, epoch $revoke_epoch) and the clawback ($CLAWBACK_TX_HASH, epoch $clawback_epoch) fall in different hours; this script posts one signal_set for both and cannot correctly represent both in a single epoch. Stopping without posting anything further."
  fi
  TRIGGER_EPOCH="$revoke_epoch"
  log "[4/7] Triggering epoch, from the real revoke and clawback transactions: $TRIGGER_EPOCH"

  NOW="$(date +%s)"
  CURRENT_EPOCH=$(( NOW / EPOCH_SECS ))
  if (( TRIGGER_EPOCH >= CURRENT_EPOCH )); then
    close_time=$(( (TRIGGER_EPOCH + 1) * EPOCH_SECS ))
    close_date="$(date -u -r "$close_time" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$close_time" +%Y-%m-%dT%H:%M:%SZ)"
    die "epoch $TRIGGER_EPOCH (the real action hour) has not closed yet; it closes at $close_date UTC. post_signals rejects an epoch that is not yet < the current epoch (check_epoch_window, contracts/risk-oracle/src/lib.rs). Wait until then and re-run; nothing further was submitted."
  fi
  epoch_close=$(( (TRIGGER_EPOCH + 1) * EPOCH_SECS ))
  window_remaining=$(( WINDOW_SECS - (NOW - epoch_close) ))
  if (( window_remaining < 0 )); then
    die "epoch $TRIGGER_EPOCH (the real action hour) is outside the 72-hour posting window (check_epoch_window); it closed too long ago to post now. Nothing further was submitted."
  fi
  window_close_date="$(date -u -r "$(( epoch_close + WINDOW_SECS ))" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$(( epoch_close + WINDOW_SECS ))" +%Y-%m-%dT%H:%M:%SZ)"
  log "epoch $TRIGGER_EPOCH's 72-hour posting window closes at $window_close_date UTC ($window_remaining seconds remaining)"
fi

# -- [5/7] Backfill plain DEMOUSD history, then fill the gap hour ----
#
# No real issuer action in the backfill hours: just the REAL current
# supply (read fresh per post, since mint/clawback can change it
# between posts) and a SAMPLE liquidity figure, so check_issuer_
# freeze's own latest_supply has something real to read even on the
# triggering epoch itself (clawback_sum / latest_supply).
#
# Backfill now stops at TRIGGER_EPOCH - 2, not TRIGGER_EPOCH - 1: the
# hour immediately before the trigger (TRIGGER_EPOCH - 1) is filled
# explicitly below with a PLAIN post (no issuer actions, supply equal
# to the last backfilled hour's own stored supply, supply_change_bps
# 0) so check_supply_change_consistency has a real, contiguous
# previous slot to compare the triggering post against. Without this
# explicit fill, there would be a real gap between the backfill's last
# post and TRIGGER_EPOCH - 1 that this script's own actions never
# touch, and read_previous_supply for the trigger would read empty
# (treated as "no check", not wrong, but less evidence than filling
# the gap deliberately provides).

if [[ -n "$TRIGGER_EPOCH" ]]; then
  log "[5/7] Backfilling $BACKFILL_HOURS hour(s) of plain $DEMO_CODE history, then filling the gap hour before epoch $TRIGGER_EPOCH"
  GAP_EPOCH=$(( TRIGGER_EPOCH - 1 ))
  FIRST_EPOCH=$(( GAP_EPOCH - BACKFILL_HOURS ))

  for (( epoch = FIRST_EPOCH; epoch < GAP_EPOCH; epoch++ )); do
    existing_signal="$(invoke_read "signals($DEMO_CODE, $epoch)" --id "$RO_ID" --source-account "$DEMO_ISSUER" \
      --network testnet --send=no -- signals --asset "$DEMO_ID" --epoch "$epoch")"
    if [[ "$existing_signal" != "null" ]]; then
      plan "backfill epoch $epoch" "already done"
      continue
    fi
    plan "backfill epoch $epoch" "will submit"
    (( DRY_RUN )) && continue

    supply_now="$(read_real_supply)"
    previous_supply="$(read_previous_supply "$epoch")"
    supply_change_bps="$(compute_supply_change_bps "$supply_now" "$previous_supply")"
    inputs_hash="$(printf 'demo-asset-backfill:%s:%s' "$epoch" "$supply_now" | shasum -a 256 | cut -d' ' -f1)"
    signal_set="{\"epoch\":$epoch,\"posted_at\":0,\"peg_ratio\":\"10000000\",\"peg_ratio_p10\":\"9998000\",\"liquidity_2pct\":\"$LIQUIDITY\",\"redemption_net\":\"0\",\"supply\":\"$supply_now\",\"supply_change_bps\":$supply_change_bps,\"issuer_actions\":{\"clawbacks\":0,\"clawback_amount\":\"0\",\"auth_revocations\":0,\"flag_changes\":0},\"endpoint\":\"Unknown\",\"inputs_hash\":\"$inputs_hash\",\"poster\":\"$KEEPER_ADDR\"}"
    if ! post_out="$("$STELLAR_BIN" contract invoke --id "$RO_ID" --source-account sylox-testnet-keeper --network testnet -- \
      post_signals --keeper "$KEEPER_ADDR" --asset "$DEMO_ID" --s "$signal_set" 2>&1)"; then
      if [[ "$post_out" == *"Error(Contract, #103)"* ]]; then
        log "epoch $epoch already posted; skipping"
        continue
      fi
      die "post_signals($DEMO_CODE, $epoch) failed:
$post_out"
    fi
    backfill_tx_hash="$(echo "$post_out" | grep -oE '[a-f0-9]{64}' | head -1)"
    log "epoch $epoch posted (plain history, real supply=$supply_now, supply_change_bps=$supply_change_bps): $backfill_tx_hash"
    note_submission "backfill epoch $epoch" "$backfill_tx_hash"
  done

  # The explicit gap fill: supply equal to the LAST BACKFILLED hour's
  # own stored supply (not today's real Horizon supply, which has
  # already moved from the clawback by the time this runs) -
  # supply_change_bps 0 is then correct by construction, not a
  # placeholder, since this post deliberately carries the same supply
  # forward unchanged.
  gap_existing_signal="$(invoke_read "signals($DEMO_CODE, $GAP_EPOCH)" --id "$RO_ID" --source-account "$DEMO_ISSUER" \
    --network testnet --send=no -- signals --asset "$DEMO_ID" --epoch "$GAP_EPOCH")"
  if [[ "$gap_existing_signal" != "null" ]]; then
    gap_supply="$(echo "$gap_existing_signal" | jq -r '.supply')"
    plan "gap-fill epoch $GAP_EPOCH" "already done" "supply=$gap_supply"
  else
    gap_supply="$(read_previous_supply "$GAP_EPOCH")"
    [[ -n "$gap_supply" ]] || die "epoch $GAP_EPOCH (the gap hour before the trigger) has no previous stored supply to carry forward; run with a larger backfill_hours so at least one real backfill post exists before it"
    plan "gap-fill epoch $GAP_EPOCH" "will submit" "supply=$gap_supply, supply_change_bps=0"
    if (( ! DRY_RUN )); then
      gap_inputs_hash="$(printf 'demo-asset-gap-fill:%s:%s' "$GAP_EPOCH" "$gap_supply" | shasum -a 256 | cut -d' ' -f1)"
      gap_signal_set="{\"epoch\":$GAP_EPOCH,\"posted_at\":0,\"peg_ratio\":\"10000000\",\"peg_ratio_p10\":\"9998000\",\"liquidity_2pct\":\"$LIQUIDITY\",\"redemption_net\":\"0\",\"supply\":\"$gap_supply\",\"supply_change_bps\":0,\"issuer_actions\":{\"clawbacks\":0,\"clawback_amount\":\"0\",\"auth_revocations\":0,\"flag_changes\":0},\"endpoint\":\"Unknown\",\"inputs_hash\":\"$gap_inputs_hash\",\"poster\":\"$KEEPER_ADDR\"}"
      if ! gap_post_out="$("$STELLAR_BIN" contract invoke --id "$RO_ID" --source-account sylox-testnet-keeper --network testnet -- \
        post_signals --keeper "$KEEPER_ADDR" --asset "$DEMO_ID" --s "$gap_signal_set" 2>&1)"; then
        if [[ "$gap_post_out" != *"Error(Contract, #103)"* ]]; then
          die "post_signals($DEMO_CODE, $GAP_EPOCH, gap fill) failed:
$gap_post_out"
        fi
        log "epoch $GAP_EPOCH already posted; skipping"
      else
        gap_tx_hash="$(echo "$gap_post_out" | grep -oE '[a-f0-9]{64}' | head -1)"
        log "epoch $GAP_EPOCH posted (gap fill, supply carried forward=$gap_supply, supply_change_bps=0): $gap_tx_hash"
        note_submission "gap-fill epoch $GAP_EPOCH" "$gap_tx_hash"
      fi
    fi
  fi
else
  plan "backfill" "cannot plan yet" "triggering epoch not yet known"
fi

if [[ -z "$TRIGGER_EPOCH" ]]; then
  plan "triggering post" "cannot plan yet" "triggering epoch not yet known"
  if (( DRY_RUN )); then
    log "dry run complete; nothing was submitted. Re-run without --dry-run to execute the plan above."
    exit 0
  fi
  die "cannot reach the triggering post: the revoke/clawback transactions do not exist yet (this should not happen outside a fresh-holder dry run)"
fi

# -- [6/7] Refuse to post if the real numbers would not actually trigger --
#
# Review finding (this session): this is the check that makes the
# earlier SUPPLY bug impossible to repeat silently. Mirrors
# check_issuer_freeze's own clawback_amount * 10000 / supply >=
# freeze_pct_bps check (contracts/event-registry/src/lib.rs) exactly,
# including its integer division, against the CURRENT canonical
# IssuerFreeze definition and the REAL supply at posting time. Runs in
# dry-run too: every call here is read-only (--send=no / Horizon
# reads), so the dry-run plan below can show the real numbers the
# triggering post would actually carry.

CANONICAL_VERSION="$(invoke_read "current_version($DEMO_CODE, IssuerFreeze)" --id "$ER_ID" --source-account sylox-testnet-admin --network testnet --send=no -- current_version --asset "$DEMO_ID" --kind '"IssuerFreeze"')"
[[ "$CANONICAL_VERSION" =~ ^[1-9][0-9]*$ ]] || die "current_version($DEMO_CODE, IssuerFreeze) is not registered ($CANONICAL_VERSION); run deploy/demo-asset.sh testnet first"
def_json="$(invoke_read "definition($DEMO_CODE, IssuerFreeze, v$CANONICAL_VERSION)" --id "$ER_ID" --source-account sylox-testnet-admin --network testnet --send=no -- definition --asset "$DEMO_ID" --kind '"IssuerFreeze"' --version "$CANONICAL_VERSION")"
FREEZE_PCT_BPS="$(echo "$def_json" | jq -r '.freeze_pct_bps')"

supply_at_trigger="$(read_real_supply)"
(( supply_at_trigger > 0 )) || die "$DEMO_CODE's real supply read as 0; cannot check the freeze threshold against it"
bps_reached=$(( CLAWBACK_AMOUNT * 10000 / supply_at_trigger ))
log "[6/7] Check: clawback_amount * 10000 / supply = $CLAWBACK_AMOUNT * 10000 / $supply_at_trigger = $bps_reached bps (threshold: freeze_pct_bps=$FREEZE_PCT_BPS)"
if (( bps_reached < FREEZE_PCT_BPS )); then
  die "the real clawback ($CLAWBACK_AMOUNT stroops) against the real supply ($supply_at_trigger stroops) is only $bps_reached bps, below freeze_pct_bps=$FREEZE_PCT_BPS. Refusing to post a signal that would not actually pass check_issuer_freeze. The revocation and clawback above already happened on-chain and cannot be undone by this script; adjust the holder's balance or claw back a larger share before posting, or accept that this asset's real numbers do not clear the registered threshold."
fi
log "Real numbers clear the threshold ($bps_reached >= $FREEZE_PCT_BPS bps); posting the triggering signal."

# -- [7/7] Post the triggering signal, with the real tx hashes --------
#
# The keeper posts the REAL action hour's signal set (TRIGGER_EPOCH,
# step 4) with issuer_actions showing exactly the revocation and the
# REAL clawback amount (read in step 3, not requested), the REAL
# supply at this moment (step 6), and the real transaction hashes
# folded into the inputs the keeper hashes (inputs_hash), so anyone
# can check the posted numbers against the chain.

log "[7/7] Posting the triggering signal for hour $TRIGGER_EPOCH"

# The bug this PR exists to fix: hardcoding 0 here is only correct
# when the real supply didn't move since the previous epoch's own
# posted supply. It genuinely moves on the triggering post itself
# (the clawback above just dropped it), so this has to be the real
# figure - see compute_supply_change_bps's own comment for exactly
# which contract check this satisfies and how. Uses gap_supply (step
# 5) directly, NOT a fresh read_previous_supply call: in a real run
# the gap fill has just posted, so the two agree, but in --dry-run the
# gap fill was only PLANNED, never actually submitted, so re-reading
# from chain here would find nothing yet and silently fall back to 0 -
# exactly the bug this PR fixes, reintroduced through the dry-run path
# specifically. gap_supply already holds the right figure either way
# (the real stored value if already posted, the real planned
# carry-forward value if not).
previous_supply_at_trigger="$gap_supply"
trigger_supply_change_bps="$(compute_supply_change_bps "$supply_at_trigger" "$previous_supply_at_trigger")"
log "supply_change_bps for epoch $TRIGGER_EPOCH: ($supply_at_trigger - $previous_supply_at_trigger) * 10000 / $previous_supply_at_trigger = $trigger_supply_change_bps"

inputs_json=$(jq -nc \
  --arg epoch "$TRIGGER_EPOCH" \
  --arg clawback_amount "$CLAWBACK_AMOUNT" \
  --arg supply "$supply_at_trigger" \
  --arg revoke_tx "$REVOKE_TX_HASH" \
  --arg clawback_tx "$CLAWBACK_TX_HASH" \
  '{epoch: ($epoch|tonumber), clawback_amount: ($clawback_amount|tonumber), supply: ($supply|tonumber), auth_revocations: 1, revoke_tx_hash: $revoke_tx, clawback_tx_hash: $clawback_tx}')
inputs_hash="$(printf '%s' "$inputs_json" | shasum -a 256 | cut -d' ' -f1)"
signal_set="{\"epoch\":$TRIGGER_EPOCH,\"posted_at\":0,\"peg_ratio\":\"10000000\",\"peg_ratio_p10\":\"9998000\",\"liquidity_2pct\":\"$LIQUIDITY\",\"redemption_net\":\"0\",\"supply\":\"$supply_at_trigger\",\"supply_change_bps\":$trigger_supply_change_bps,\"issuer_actions\":{\"clawbacks\":1,\"clawback_amount\":\"$CLAWBACK_AMOUNT\",\"auth_revocations\":1,\"flag_changes\":0},\"endpoint\":\"Unknown\",\"inputs_hash\":\"$inputs_hash\",\"poster\":\"$KEEPER_ADDR\"}"

existing_trigger_signal="$(invoke_read "signals($DEMO_CODE, $TRIGGER_EPOCH)" --id "$RO_ID" --source-account "$DEMO_ISSUER" \
  --network testnet --send=no -- signals --asset "$DEMO_ID" --epoch "$TRIGGER_EPOCH")"
if [[ "$existing_trigger_signal" != "null" ]]; then
  plan "triggering post" "already done" "epoch=$TRIGGER_EPOCH"
  log "epoch $TRIGGER_EPOCH already posted (a prior run got this far); not posting again"
else
  plan "triggering post" "will submit" "epoch=$TRIGGER_EPOCH, previous_supply=$previous_supply_at_trigger, supply=$supply_at_trigger, supply_change_bps=$trigger_supply_change_bps, clawback_amount=$CLAWBACK_AMOUNT, inputs_hash=$inputs_hash"

  if (( ! DRY_RUN )); then
    # RESUME NOTE: if a prior run already posted this exact epoch
    # between the read above and this call (e.g. a second instance of
    # this script running concurrently), post_signals itself rejects
    # the repeat with #103 EpochAlreadyPosted - the same signal the
    # backfill loop (step 5) already treats as "already done", not a
    # failure, here too.
    if ! trigger_out="$("$STELLAR_BIN" contract invoke --id "$RO_ID" --source-account sylox-testnet-keeper --network testnet -- \
      post_signals --keeper "$KEEPER_ADDR" --asset "$DEMO_ID" --s "$signal_set" 2>&1)"; then
      if [[ "$trigger_out" == *"Error(Contract, #103)"* ]]; then
        log "epoch $TRIGGER_EPOCH already posted; not posting again"
      else
        die "post_signals($DEMO_CODE, $TRIGGER_EPOCH, the triggering signal) failed:
$trigger_out"
      fi
    else
      echo "$trigger_out"
      trigger_tx_hash="$(echo "$trigger_out" | grep -oE '[a-f0-9]{64}' | head -1)"
      log "triggering signal posted for epoch $TRIGGER_EPOCH: clawback_amount=$CLAWBACK_AMOUNT (real), supply=$supply_at_trigger (real), supply_change_bps=$trigger_supply_change_bps (real), auth_revocations=1, tx=$trigger_tx_hash"
      log "inputs (with real tx hashes): $inputs_json"
      note_submission "triggering post" "$trigger_tx_hash"
    fi
  fi
fi

if (( DRY_RUN )); then
  log "dry run complete; nothing was submitted. Re-run without --dry-run to execute the plan above."
  exit 0
fi

PENDING_UNTIL=$(( $(date +%s) + 7200 ))
log "This signal is Pending until $(date -u -r "$PENDING_UNTIL" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$PENDING_UNTIL" +%Y-%m-%dT%H:%M:%SZ) UTC (signal_dispute_secs, 2h), then effectively Final."
log "propose_tier1 reads effectively-Final slots (ADR-008): this script does NOT wait for that; run deploy/demo-asset-propose.sh testnet once that time has passed."

# Every real transaction this run actually submitted, by label, with
# its hash - collected by note_submission as each one landed, so this
# summary is a direct report of what happened, not a re-derivation.
# Empty when every step read "already done" (a fully resumed run).
if (( ${#SUBMITTED_TX_HASHES[@]} > 0 )); then
  log "Submitted ${#SUBMITTED_TX_HASHES[@]} real transaction(s) this run:"
  for label in "${!SUBMITTED_TX_HASHES[@]}"; do
    log "  $label: ${SUBMITTED_TX_HASHES[$label]}"
  done
else
  log "Submitted 0 real transactions this run (everything was already done)."
fi
