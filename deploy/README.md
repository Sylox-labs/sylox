# Testnet deploy order

Run these in this exact order. Running them out of order is not just
unsupported, it silently makes the asset take far longer to start
scoring (see the note on `first_epoch` below) — `deploy/smoke-
testnet.sh` refuses to run until there is posting history, specifically
to make getting this wrong harder.

1. `deploy/deploy.sh testnet`
   Deploys and wires the four contracts, issues TUSD, registers the
   tracked asset, and writes `deployments/testnet.json`.

2. `deploy/post-demo-signals.sh testnet [epochs]`
   Backfills synthetic demo signals so the oracle has history. Must
   run before step 3. Posts oldest epoch first.

3. `deploy/smoke-testnet.sh`
   Verifies the live deployment. Refuses to run if the tracked asset
   has no posting history yet (`RiskOracle.first_epoch` is `None`),
   specifically to stop this script's own write check from becoming
   the asset's first-ever post (see below).

4. Continuous posting, via `deploy/post-demo-signals.sh testnet --live`
   on a 5-minute loop, first on a local machine as a stopgap, then as
   a Railway cron job once this merges, until a real keeper service
   exists. Never run alongside the backfill or smoke test on the same
   asset; see `--live`'s own section below.

## Why the order matters: `first_epoch` is write-once

`RiskOracle.first_epoch(asset)` is set exactly once, by whichever post
reaches the contract first for that asset
(`storage::set_first_epoch_if_unset`), and it never moves afterward.
`score()`'s 7 day history requirement (`AGGREGATE_SLOTS_7D`, 168
epochs, technical-doc.md Section 6.5) counts forward from `first_epoch`,
not from "now" and not from the oldest epoch ever posted.

If `smoke-testnet.sh` runs before `post-demo-signals.sh`, its own write
check (which posts one fresh epoch if the asset has no history yet)
becomes the asset's first-ever post. `first_epoch` then latches onto
that moment. When the backfill runs afterward and posts OLDER epochs
into the past, that data lands fine in the ring and signal archive, but
`first_epoch` has already been claimed and never moves to reflect the
older history. The asset then needs a full 168 hours counted forward
from that late `first_epoch`, instead of the ~96 additional hours it
would need if `first_epoch` had correctly landed on the oldest
backfilled epoch (168 total, 72 of them already backfilled).

This happened once already during this project's testnet redeploy
(PR #35) and cost a full redeploy-and-backfill cycle to fix. Known gap,
tracked separately (not fixed here): `set_first_epoch_if_unset` could
instead lower `first_epoch` when an older epoch is posted after the
fact, but `first_epoch` is also read by the aggregation's missing-hour
accounting, so that change needs its own review, likely alongside
`upgrade()`.

## `post-demo-signals.sh`'s own timing

This script takes real wall-clock minutes to post a multi-epoch
backfill. It recomputes "now" and the newest closed epoch fresh before
every single post, rather than once at the start, and skips (logging
it) rather than aborts if a requested epoch has not actually closed by
the time its own turn comes. The `epochs` argument is capped at 71, one
less than the 72 hour backfill window `RiskOracle.check_epoch_window`
enforces, so the oldest requested epoch always has at least one epoch
of slack left when the run reaches it.

A second, narrower version of the same timing issue exists one level
down: each sub-epoch within an hour has its OWN close time, strictly
earlier than the hour's close for every sub before the last, and its
own `SUB_BACKFILL_SECS` (2h) staleness bound measured from THAT close,
not the hour's. A long-running backfill can post through most of an
hour's sub-epochs and have the earliest ones go stale before it gets
to them, even while the hour itself is still safely within its own
window — observed for real on the last hour of a 71-epoch run. Fixed
the same way: skip (log it) an individual sub-epoch whose own window
has closed, never abort the hour over it.

## `--live` mode

`deploy/post-demo-signals.sh testnet --live` runs ONE pass of ongoing
posting, meant to be invoked on a fixed interval (every 5 minutes),
never as a long-running process itself. Each pass posts every closed,
not-yet-posted sub-epoch of the current hour and the previous hour (so
a single missed tick still gets caught up on the next one), reading
the asset's real `sub_epoch_secs` from `RiskOracle.sub_epoch_config`.
It never falls back to the hourly path — hours build on their own once
every one of their sub-epochs settles (technical-doc.md Section 5.9
S4) — and treats a sub-epoch that is already posted as a normal,
expected skip, not a failure, since most 5-minute ticks between a
sub-epoch's own close times will hit exactly that.

Do not run `--live` at the same time as a backfill (`post-demo-
signals.sh testnet <epochs>`) or `smoke-testnet.sh`'s own write check
against the same asset: both can post against the same hour `--live`
is also targeting, and either order of two concurrent posts to the
same sub-epoch is a race, not a correctness issue by itself (the
contract's own `EpochAlreadyPosted`/`HourAlreadyPosted` guards make
the loser a harmless, logged skip either way), but it makes a single
run's own log confusing to read. Finish a backfill and smoke test
fully before starting `--live`, same as the deploy order above.

`--live` only ever targets the one tracked asset in `deployments/
testnet.json`. DEMOUSD (`deploy/demo-asset.sh`, `deploy/demo-asset-
trigger.sh`) is deliberately NOT in the loop: its own `IssuerFreeze`
check has no history minimum (see `deploy/demo-asset-trigger.sh`'s own
header comment), so nothing needs its hours to keep advancing once the
triggering signal is posted. This means DEMOUSD reads as stale once
its last posted hour ages out (`stale_after_epochs`, Section 5.5) —
expected, and harmless for a one-shot IssuerFreeze demo. A cure demo
would be different: Depeg's own cure path (`checkpoint_cure`,
`finalize`'s `cure_outcome`) reads the asset's ring going forward
through the challenge window, so that would need DEMOUSD (or whichever
asset demos it) added to `--live`, extended to target more than one
asset at a time, which it does not do today.

## DEMOUSD's 1 hour challenge window

`deploy/demo-asset.sh` registers DEMOUSD's `IssuerFreeze` definition
with `challenge_secs = 3600` (1 hour, `CHALLENGE_SECS_MIN_EPOCHS`, the
shortest allowed), not the 24 hour window USDC's own `Depeg`
definition uses. This is deliberate and DEMOUSD-only, so `finalize`
becomes reachable within an hour of `propose_tier1` rather than a full
day; it exists purely so a demo can be walked through quickly, not
because it reflects a real challenge period. `checkpoint_cure` is not
relevant here regardless of `challenge_secs`: it explicitly rejects
any non-`Depeg` event (`WrongState`), so `finalize` is the only call
that moves an `IssuerFreeze` event forward. Never change USDC's own
definitions to match this short window.
