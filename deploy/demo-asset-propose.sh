#!/usr/bin/env bash
# Calls propose_tier1(DEMOUSD, IssuerFreeze) and reports the resulting
# event. Run deploy/demo-asset-trigger.sh testnet first, and wait for
# its own triggering signal to become effectively Final (posted_at +
# signal_dispute_secs, 2h; that script prints the exact time).
#
# Usage: deploy/demo-asset-propose.sh testnet

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
[[ -f "$DEMO_RECORD" ]] || { echo "FATAL: $DEMO_RECORD not found; run deploy/demo-asset.sh testnet first" >&2; exit 1; }

STELLAR_BIN="${STELLAR_CLI_BIN:-stellar}"
ER_ID="$(jq -r '.contracts.event_registry.id' "$RECORD")"
ADMIN=sylox-testnet-admin   # Identity alias (signing key), not the bare address: deploy.sh's own convention.
ADMIN_ADDR="$(jq -r '.identities.admin' "$RECORD")"
DEMO_ID="$(jq -r '.demo_asset.contract_id' "$DEMO_RECORD")"

log() { echo "==> $*"; }
die() { echo "FATAL: $*" >&2; exit 1; }

CANONICAL_VERSION="$("$STELLAR_BIN" contract invoke --id "$ER_ID" --source-account "$ADMIN_ADDR" --network testnet --send=no -- current_version --asset "$DEMO_ID" --kind '"IssuerFreeze"' 2>&1)"
[[ "$CANONICAL_VERSION" =~ ^[1-9][0-9]*$ ]] || die "current_version(DEMOUSD, IssuerFreeze) is not a registered version ($CANONICAL_VERSION); run deploy/demo-asset.sh testnet first"
log "canonical IssuerFreeze version for DEMOUSD: $CANONICAL_VERSION"

log "propose_tier1(DEMOUSD, IssuerFreeze, version $CANONICAL_VERSION)"
if ! propose_out="$("$STELLAR_BIN" contract invoke --id "$ER_ID" --source-account "$ADMIN" --network testnet -- \
  propose_tier1 --caller "$ADMIN_ADDR" --asset "$DEMO_ID" --kind '"IssuerFreeze"' --version "$CANONICAL_VERSION" 2>&1)"; then
  die "propose_tier1(DEMOUSD, IssuerFreeze) failed (if the triggering signal from demo-asset-trigger.sh is not Final yet, this returns Tier1CheckFailed - wait past the time that script printed):
$propose_out"
fi
echo "$propose_out"
EVENT_ID="$(echo "$propose_out" | grep -oE '^[0-9]+$' | head -1)"
[[ -n "$EVENT_ID" ]] || EVENT_ID="$propose_out"
log "event id: $EVENT_ID"

log "EventRegistry.event($EVENT_ID)"
event_out="$("$STELLAR_BIN" contract invoke --id "$ER_ID" --source-account "$ADMIN_ADDR" --network testnet --send=no -- event --event_id "$EVENT_ID" 2>&1)"
log "event($EVENT_ID): $event_out"
if [[ "$event_out" == *"Proposed"* ]]; then
  log "Confirmed: event is Proposed."
else
  log "Event state is NOT Proposed; read the output above."
fi
