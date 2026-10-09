# EventRegistry design note: Tier 1 (Depeg and IssuerFreeze)

Status: Draft, for review before any contract code · Date: October 9, 2026

Source: technical-doc.md v1.4 Section 8, 12.2, 13, 14, 15, 21; ADR-001, 002, 003, 005, 006, 007, 008, 012.

Scope: `register_definition`, `propose_tier1` (Depeg, IssuerFreeze), `challenge`, `finalize` (incl. cure), `rule`, `resolve_timeout`, every Section 12.2 read, `RiskOracle` pushes, bonds via `Staking`. Out of scope, each a known-gap issue once approved: `propose_tier2` (WithdrawalHalt), `propose_tier3` (Insolvency), `MintWithoutBacking`. No stub functions for any of the three.

## 1. State machine

| From | To | Trigger | Who | Exact time condition |
| --- | --- | --- | --- | --- |
| None | Proposed | `propose_tier1` passes checks | Anyone | Checks pass now; no time gate on entry |
| None (stale Cured/Rejected) | None | Lazy, checked inside the next `propose_tier1` for the same (asset, kind, version) | Anyone | `now >= left_at + cooldown_secs` |
| Proposed | Escalated | `challenge` with bond | Anyone | Inside `challenge_secs` of `proposed_at`; escalates in the SAME call, so `Challenged` is never an observed storage value, only the diagram's name for this instant |
| Proposed | Declared | `finalize`, no challenge ever posted | Anyone | `now >= proposed_at + challenge_secs` |
| Proposed | Cured | `finalize`, Depeg only | Anyone | `now >= proposed_at + challenge_secs` AND every epoch in the window is effectively Final AND all are `>= cure_threshold` |
| Escalated | Declared / Rejected | `rule(declare, reason)` | Committee | Before `escalated_at + ruling_deadline_secs` |
| Escalated | Declared (Tier 1 only) | `resolve_timeout` | Anyone | `now >= escalated_at + ruling_deadline_secs` |
| Cured / Rejected | None | cooldown elapses | n/a (lazy, see above) | `now >= left_at + cooldown_secs` |
| Declared | (terminal) | none | n/a | No function ever leaves Declared |

Two implicit points this table makes explicit: (1) `Challenged` has no independent lifetime — `challenge` writes `Escalated` directly, per Section 8.1's own "no event can sit in Challenged with no clock running." (2) Cooldown is lazy: there is no sweep function; `propose_tier1` itself recognizes an expired `Cured`/`Rejected` record as `None` before running its own checks.

## 2. Definition versions (lead decision)

`propose_tier1(caller, asset, kind, version) -> u64`. Deviates from Section 8.1/8.2/8.8 and ADR-001, which take only (asset, kind) and always the canonical version. Reason: a series pins the version canonical when it opened; a newer version can supersede that one while the series is still live, and a real failure discovered after that point must still be provable against the OLDER, still-pinned version, or Section 8.6's coverage rule can never actually pay that series out.

Rules:
- `version` must be registered (`UnknownDefinition` otherwise, which already covers "no such version").
- `version` must not be retired: retired = a strictly newer version exists AND no live series still pins it. **Until `MarketFactory` exists (out of scope here), this can never be observed true, so every non-canonical version is treated as proposable.** Conservative in the safe direction; costs nothing but a slightly longer proposable window.
- Not definition shopping: every nameable version was itself a real, governance-approved canonical definition at some point, under the ordinary `register_definition` checks. There is no larger space of definitions to pick from, only a wider span of time an already-approved one can still be asserted against.

`covers()` is unchanged (Section 8.6): it already compares the EVENT's own `def_version` against the series' pinned version, so this decision is what finally makes that comparison do real work for a superseded version. `current_version`/`definition` reads are unaffected.

## 3. Tier 1 data reads

Each check reads `RiskOracle.ring(asset)` (one call, 240 slots, oldest first) for values, and `RiskOracle.effective_window(asset, start, count)` for the authoritative per-epoch finality verdict. `EventRegistry` never re-derives "Pending past `pending_until` counts as Final" from `ring()`'s raw `state` field itself (Section 8.2's own requirement), even though `RingSlot` carries enough fields to do so — `effective_window` is the one place that rule can change; every caller should go through it.

**Window anchor:** both checks end at the close of the latest EFFECTIVELY FINAL epoch (ADR-008), not latest posted. `RiskOracle` exposes no direct read for this; `propose_tier1` finds it by walking its own already-fetched `ring()`/`effective_window()` result backward, capped at 240 slots (ADR-008's own backward-scan bound). No data anywhere Final: `Tier1CheckFailed`.

**Depeg**, window = `depeg_window_secs` (default 72 epochs) ending there:
- For each epoch: if effectively Final, compare `peg_ratio < depeg_threshold`; one failing present epoch fails the whole check immediately.
- Not effectively Final = missing, counted neither for nor against.
- After the scan: `missing_count > max_missing_epochs` (default 6 of 72) fails the check, even if every present epoch passed.
- Liquidity floor: median `liquidity_2pct` of the effectively-Final slots in the 168 epochs (7 days) immediately BEFORE the window (a separate slice from the window itself; the two together span at most 240 epochs, exactly `RING_SLOTS`, matching why `register_definition` rejects a window+baseline that would not fit). Missing baseline epochs are excluded from the median, not zeroed; an all-missing baseline fails closed.
- `window_start` = start of the window's own first epoch.

**IssuerFreeze**, window = 7 days ending there:
- Sum effectively-Final epochs' `clawback_amount`/`auth_revocations`. Missing epochs contribute nothing (can only undercount, never trigger on absence, so no `max_missing_epochs`-style cap is needed here).
- Passes if `clawback_amount_sum / supply >= freeze_pct_bps` (supply from the latest effectively-Final epoch) OR `auth_revocations_sum` above threshold, AND the counted actions are not fully excluded (Section 4).
- `window_start` = start of the earliest effectively-Final epoch with a counted (non-excluded) action.

Missing data never counts as a trigger in either check: Depeg bounds it by `max_missing_epochs`, IssuerFreeze can only undercount from it. A keeper outage can make a real failure harder to prove, never easier.

## 4. IssuerFreeze gating

**Definition-time gate (unchanged):** `register_definition` rejects IssuerFreeze for an asset whose `issuer_flags` has neither `auth_revocable` nor `clawback_enabled` (`FreezeImpossible`), checked once at registration, never re-checked at `propose_tier1` time.

**Compliance exclusion (new; the spec names this requirement in one sentence, Section 8.2, with no mechanism defined anywhere):**

```rust
fn exclude_compliance_action(env, asset: Address, epoch: u64, reason: BytesN<32>); // auth: governor
fn is_compliance_excluded(env, asset: Address, epoch: u64) -> bool;
```

`RingSlot.clawback_amount`/`auth_revocations` are per-EPOCH aggregate counts, not per-action records — there is no finer identifier anywhere in the oracle data model to exclude a single transaction by. This note excludes at epoch granularity: an excluded epoch's counted actions read as zero for the IssuerFreeze sum (Section 3), but the epoch itself still counts toward the window's own span (not treated as missing). `governor.require_auth()` directly, no `Governor::Action` variant (`Governor` is not built; mirrors how `Staking`/`Treasury` already check a plain `governor: Address` today). Not retroactive: it only changes what a FUTURE `propose_tier1` call sums; an event already Proposed or Escalated is unaffected (a live dispute on this exact ground goes through `challenge`/`rule` instead).

## 5. Cure (Depeg only)

```
earliest_finalize_at = proposed_at + challenge_secs
```

At that instant, `finalize` requires every epoch in `[window_start, window_start + depeg_window_secs)` to be effectively Final before deciding anything (no Pending data decides a cure). If any epoch is not yet Final, `finalize` is a no-op (no state change, no error): callable again once the gap backfills. This is the one place Section 8 does not spell out the "data not ready yet" case explicitly; a no-op is the only reading consistent with the task's own instruction that avoids both deciding on incomplete data and inventing a new error code for "try again later." In practice this is rare: `pending_until` for even the newest window epoch is only `signal_dispute_secs` (2h) past its own close, well inside `challenge_secs` (24h).

Once every epoch is Final: all `>= cure_threshold` → Cured. Otherwise → Declared (the original Depeg condition already held at proposal time; an incomplete recovery does not undo that).

## 6. RiskOracle flag (lead decision)

One asset can have several (kind, version) events live at once, but `set_event_in_progress` is one boolean. `EventRegistry` keeps `ActiveCount(asset)` (persistent, new key) instead of pushing the boolean directly off its own transitions:

- Entering Proposed/Escalated: increment; push `true` only on 0 → 1.
- Leaving those states (Declared, Cured, Rejected, or back to None): decrement; push `false` only on nonzero → 0.
- On Declared specifically: call `set_event_band(asset)` BEFORE decrementing (Section 8.5's own step order: band set, then bonds, then event) — `set_event_band`'s `Event` floor is stronger than `set_event_in_progress`'s `Distress` floor, so setting it first means the band is never briefly under-floored between the two calls.

New read: `active_event_count(asset) -> u32`.

**Invariant E4:** after every call, `RiskOracle`'s own stored `event_in_progress(asset)` flag equals `active_event_count(asset) > 0`. `RiskOracle` exposes no direct public read of this boolean (only `set_event_in_progress` to write it); tests observe it through its one documented effect, `band(asset)` floored to at least `Distress` (Section 6.3), using an asset whose price-driven band is independently known to be below `Distress`, so the floor's own effect is unambiguous rather than masked by a coincidentally-already-high band. Tested per transition, by the property test after every op across 2 assets, and by a dedicated scenario (two kinds live, one rejected, flag stays true) — the exact case a naive boolean push would get wrong.

## 7. Bonds

Tier 1 proposers post no bond (`EventRecord.bond == 0`). Only the challenger's `EventChallenge(event_id)` bond (subject `None`, like every event bond kind) is ever at stake.

| Outcome | Challenger's bond |
| --- | --- |
| `finalize`, unchallenged or cured | n/a, never locked |
| `rule(declare = true)` | `forfeit_bond(winner = None)`: 100% to Treasury's `Slashed` (no second bonded party exists for Tier 1) |
| `rule(declare = false)` | `release_bond`: full amount back |
| `resolve_timeout`, any outcome | `release_bond`: full amount back, even though the default outcome may be Declared — ADR-002's own rule is unconditional ("nobody is slashed for the committee's silence") |

**Invariant E5 (every bond settles exactly once):** structural, the same way `Staking`'s own I17 holds for every bond kind — `Escalated` is left exactly once per event, so `release_bond`/`forfeit_bond` is reachable exactly once per `event_id`; a hypothetical double-call hits `Staking`'s own `UnknownBond` (the record is cleared on first settlement), failing loudly rather than silently double-paying.

## 8. Coverage

`window_start` (Section 3) is stored on `EventRecord.window_start` at `propose_tier1` time. `covers(event_id, def_version, start, expiry)` implements Section 8.6 unchanged: kind matches a key of `def_versions` and `def_version` equals the pinned one; `start <= window_start <= expiry`; `proposed_at <= expiry + window_len(kind)`. No extra calls needed inside `covers` itself.

`cover_gate(asset)`, first-match order (ADR-003, Section 9.4):

1. `active_event_count(asset) > 0` → `EventInProgress` (reuses Section 6's own count).
2. Any epoch, Pending OR Final, in the trailing `depeg_window_secs` below `depeg_threshold` → `RecentDepeg` (deliberately looser than the Tier 1 check itself: a buyer should not buy the instant a bad, not-yet-Final price posts).
3. Endpoint Down/Degraded in the trailing `halt_window_secs` → `RecentEndpointOutage`.
4. Any clawback/revocation in the last 7 days → `RecentIssuerAction`. Judgment call: this does NOT apply the Section 4 compliance exclusion — the gate warns buyers off recent issuer activity regardless of whether it is later excluded from a payout decision; a caution signal, not a ruling.
5. Otherwise → `Clear`.

## 9. Invariants

| Id | Invariant | Primary test |
| --- | --- | --- |
| E1 | Declared only via unchallenged `finalize`, `rule(declare=true)`, or Tier 1 `resolve_timeout` | One unit test per path; property test asserts no other sequence reaches Declared |
| E2 | Declared is terminal | Every other function on an already-Declared event returns `WrongState` |
| E3 | At most one non-terminal event per (asset, kind, version) | Unit test: second `propose_tier1` while one is live returns `EventInProgress`; property test keeps a shadow map |
| E4 | Oracle flag == (active count > 0) | Section 6 |
| E5 | Every bond settles exactly once | Section 7 |

I13 (every live series pins the current canonical version) is unaffected: it constrains what a SERIES pins at open time, never what a PROPOSAL may target, so it coexists with Section 2's own decision. I7's prose ("committee `rule` before the ruling deadline") should gain an explicit `declare = true` qualifier once this reconciles with code; not a behavior change.

## 10. Attacks

| Attack | What stops it |
| --- | --- |
| Single-epoch price wick | Every present epoch in the 72-epoch window must fail, not a minimum; `peg_ratio_p10` already filters wicks out of the score separately |
| Keeper outage creating gaps | `max_missing_epochs` tolerates a bounded gap; beyond it the proposal fails closed, never passes on absence |
| Liquidity collapse during a real failure (must still trigger) | Liquidity floor checks only the 7-day baseline BEFORE the window, never liquidity inside it |
| Challenger griefing a valid event | Challenger's own bond is the entire stake; losing a ruling forfeits 100% to Treasury |
| Seller forcing a cure with a brief spike | Cure needs every epoch in the full window at or above `cure_threshold`, not a moment; one epoch still below routes to Declared |
| Proposing against a version no series uses | No bond is risked and no payout follows unless some live series' `covers()` also matches that exact version; wastes gas, gains nothing |
| Two kinds in progress, one rejected | Exactly Section 6's own motivating case: the count stays above zero, oracle flag stays true |

## 11. Test plan

Unit: every function and error path (`register_definition`'s 7 rejections; `propose_tier1` for both kinds, each branch of Section 3; `exclude_compliance_action` auth and idempotency; `challenge`/`finalize`/`rule`/`resolve_timeout` and their failure modes from Section 1, 5, 7; every Section 12.2 read including `cover_gate`'s 5 outcomes and `covers`'s 4 conditions).

Scenario: the day-88-of-90 depeg (Section 8.6); a ruling-deadline timeout for each Tier 1 default; a definition change with a live series still on the old version, proving Section 2's own decision; two kinds live with one rejected (Section 6, 10); a compliance exclusion flipping an IssuerFreeze proposal; a cure attempted mid-backfill, then completed (Section 5).

Property (`proptest`, matching `staking`/`treasury`'s own convention): random `propose_tier1` (both kinds, random registered versions), `challenge`, `rule`, `resolve_timeout`, `register_definition`, `exclude_compliance_action`, across 2 assets and both kinds, asserting E1 to E4 after every step. E5 is structural, not fuzzed, matching how this workspace already documents rather than fuzzes its other structurally-provable invariants.

**Integration: confirmed, will use the real `RiskOracle`, `Staking` and `Treasury`**, matching `staking::test::integration`'s own existing convention. Full cycle: real asset, keeper posts a genuine depeg pattern, `propose_tier1` against real oracle data, unchallenged `finalize` to Declared with real `set_event_band`/`set_event_in_progress` calls observed; a separate challenged path with a real `Staking` bond, ruled by a committee address, confirming the loser's forfeited bond reaches `Treasury`'s `Slashed` bucket via a real `deposit` (ADR-012). Every balance asserted at the end.

## 12. Deviations, with reasons

1. **`propose_tier1` takes an explicit `version`** (Section 2): the task's own lead decision, overriding Section 8.1/8.2/8.8 and ADR-001's "(asset, kind) only, always canonical."
2. **Compliance-action exclusion is invented here** (Section 4): the spec names the requirement in one sentence with no mechanism; this note designs it at epoch granularity, the finest the existing `RingSlot` data supports.
3. **`finalize` on an incomplete Depeg window is a no-op, not an error** (Section 5): the only reading consistent with "may not run until every epoch is Final" that does not also require inventing a new error code.
4. **`ActiveCount(asset)` replaces a boolean push** (Section 6): the task's own lead decision; Section 8.1's own prose ("while ANY event... is in progress") already implied this, a plain boolean just could not express it correctly for more than one live event.
5. **`cover_gate` does not apply the compliance exclusion** (Section 8): a judgment call, not forced by any existing rule, since the gate's spec predates this note's exclusion mechanism entirely.
6. **I7's wording gap** (Section 9): a precision note, not a behavior change.
7. **Retirement is a no-op until `MarketFactory` exists** (Section 2): the task's own explicit instruction.
8. **E4 cannot be tested by reading the oracle flag directly** (Section 6): `RiskOracle` has no public read for its own `event_in_progress` boolean, only the write (`set_event_in_progress`) and its one observable effect (`band` floored to `Distress`). Not a deviation in behavior, a testing-design finding: E4's tests must control for an asset whose price-driven band would otherwise already be `Distress` or `Event`, or the floor's effect is unobservable from outside the contract.

No other part of the cited source of truth required a deviation; the rest of Section 8 and 12.2 maps onto this design directly.
