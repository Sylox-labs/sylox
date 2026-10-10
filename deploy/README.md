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

4. Continuous posting (one epoch every 5 minutes), via
   `deploy/post-demo-signals.sh testnet 1` on a loop, until a real
   keeper service exists.

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
