# EventRegistry design note: Tier 1 (Depeg and IssuerFreeze)

Status: Draft, for review before any contract code · Date: October 9, 2026

Source: technical-doc.md v1.4 Section 8, 12.2, 13, 14, 15, 21; ADR-001, 002, 003, 005, 006, 007, 008, 012.

Scope: `register_definition`, `propose_tier1` (Depeg, IssuerFreeze), `challenge`, `finalize` (incl. cure), `rule`, `resolve_timeout`, every Section 12.2 read, `RiskOracle` pushes, bonds via `Staking`. Out of scope, each a known-gap issue once approved: `propose_tier2` (WithdrawalHalt), `propose_tier3` (Insolvency), `MintWithoutBacking`. No stub functions for any of the three.

## 1. State machine

| From | To | Trigger | Who | Exact time condition |
| --- | --- | --- | --- | --- |
| None | Proposed | `propose_tier1` passes checks | Anyone | Checks pass now; no time gate on entry |
| None (Cured/Rejected, new data) | None | Lazy, checked inside the next `propose_tier1` for the same (asset, kind, version) | Anyone | The new proposal's own `window_start` is strictly after `left_at` (the time the prior event left Proposed/Escalated into Cured or Rejected); see Section 2a |
| Proposed | Escalated | `challenge` with bond | Anyone | Inside `challenge_secs` of `proposed_at`; escalates in the SAME call, so `Challenged` is never an observed storage value, only the diagram's name for this instant |
| Proposed | Declared | `finalize`, no challenge, cure window data settled (no epoch "not ready"), AND (any epoch permanently missing OR any Final epoch below `cure_threshold`) | Anyone | `now >= proposed_at + challenge_secs` AND no cure-window epoch is "not ready" (Section 5) |
| Proposed | Cured | `finalize`, Depeg only, no challenge | Anyone | `now >= proposed_at + challenge_secs` AND every cure-window epoch is Final (zero permanently missing, zero "not ready") AND every one is `>= cure_threshold` (Section 5, review item R1: strict, no partial credit) |
| Proposed | Proposed (no transition) | `finalize` while some cure-window epoch is still "not ready" | Anyone | Returns `DataNotFinal`; callable again later (Section 5) |
| Escalated | Declared / Rejected | `rule(declare, reason)` | Committee | Before `escalated_at + ruling_deadline_secs` |
| Escalated | Declared (Tier 1 only) | `resolve_timeout` | Anyone | `now >= escalated_at + ruling_deadline_secs` |
| Cured / Rejected | None | a later proposal with `window_start > left_at` | Anyone (that later proposal's own caller) | See Section 2a; no time-based cooldown |
| Declared | (terminal) | none | n/a | No function ever leaves Declared |

Two implicit points this table makes explicit: (1) `Challenged` has no independent lifetime — `challenge` writes `Escalated` directly, per Section 8.1's own "no event can sit in Challenged with no clock running." (2) **Revised (review item D4): re-proposal is gated by new data, not a time cooldown.** There is no `cooldown_secs` and no sweep function; `propose_tier1` itself recognizes a stale `Cured`/`Rejected` record as `None`, but only once the NEW proposal's own computed `window_start` is strictly after the OLD event's `left_at` (Section 2a).

## 2. Definition versions (lead decision)

`propose_tier1(caller, asset, kind, version) -> u64`. Deviates from Section 8.1/8.2/8.8 and ADR-001, which take only (asset, kind) and always the canonical version. Reason: a series pins the version canonical when it opened; a newer version can supersede that one while the series is still live, and a real failure discovered after that point must still be provable against the OLDER, still-pinned version, or Section 8.6's coverage rule can never actually pay that series out.

**Revised (review item D3): accepting ANY registered version was wrong — it is a free grief.** `Event` is a sticky, asset-wide band (Section 6.3) that blocks every series on the asset, not only series pinned to the proposed version. A version superseded for being too loose (for example, a Depeg definition governance tightened after finding its `depeg_threshold` too easy to trigger) would otherwise still let anyone propose a free (unbonded, Section 8.2) Tier 1 event against the ORIGINAL, looser version, forcing `Event` onto the whole asset under a rule the CURRENT definition would not have triggered under. Since Tier 1 posts no bond, nothing stops this from being tried speculatively, repeatedly, for free.

Corrected rules:
- `version` must be registered (`UnknownDefinition` otherwise).
- **`version` is accepted only if it is the current canonical version, OR is pinned by at least one live series.** The series check is routed through one function, `version_has_live_cover(asset, kind, version) -> bool`, so there is exactly one place to change when `MarketFactory` ships. Until `MarketFactory` exists (out of scope here), `version_has_live_cover` always returns `false` — so in THIS phase, `propose_tier1` only ever accepts the canonical version, exactly as the un-amended spec already specifies, and the version parameter stays in the signature inert until `MarketFactory` gives it something real to check.
- Not definition shopping within what IS accepted: a non-canonical version only becomes proposable once a real, live series can be shown to still depend on it, never merely because it was once registered.

**Asset-wide effects happen only for a canonical-version event (D3.b):** `ActiveCount(asset)` (Section 6), the `set_event_in_progress` push, and `set_event_band` are updated ONLY when the event's own `def_version` equals `current_version(asset, kind)` at the time of the relevant transition. A non-canonical event (reachable only once `MarketFactory` exists and a live series still pins an older version) affects exactly what `covers()` already scopes it to: payout for series pinned to that specific version, nothing asset-wide. Concretely:

- `propose_tier1` against a non-canonical version does NOT increment `ActiveCount(asset)` and does NOT push `set_event_in_progress(asset, true)`.
- `finalize`/`rule`/`resolve_timeout` reaching Declared for a non-canonical-version event does NOT call `set_event_band(asset)`.
- `cover_gate(asset)`'s own `EventInProgress` check (Section 8) reads `ActiveCount(asset)` exactly as before, which, under this correction, now only ever reflects canonical-version activity — so it is unaffected by this change in behavior, only in which proposals can increment it in the first place.

This also resolves a question the first draft of this note left implicit: since the only version `propose_tier1` can target in this phase is canonical, EVERY Tier 1 event in this phase IS a canonical-version event by construction, and the asset-wide/series-only distinction above is a no-op until `MarketFactory` exists — exactly like the version-acceptance rule it depends on. The design is written for the general case now so no further change to `EventRegistry` itself is needed when `MarketFactory` ships and non-canonical proposals become reachable.

`covers()` is unchanged (Section 8.6): it already compares the EVENT's own `def_version` against the series' pinned version, so this decision is what finally makes that comparison do real work for a superseded version, once one becomes reachable. `current_version`/`definition` reads are unaffected.

## 2a. Re-proposal after Cured or Rejected (review item D4)

**A fixed `cooldown_secs` was wrong.** A 7-day cooldown after Rejected could push a genuine, ongoing failure's own proposable window (bounded by Section 8.6's own acceptance period, `expiry + window_len(kind)`) past the point a series could still be covered, so a real failure the first ruling simply got wrong could end up paying nobody, through no fault of the failure itself continuing.

**Replacement rule:** after an event for (asset, kind, version) leaves Proposed/Escalated into Cured or Rejected at `left_at`, the NEXT `propose_tier1` call for the same (asset, kind, version) is accepted only if its own freshly computed `window_start` (Section 3) is strictly greater than `left_at`. No time-based gate at all; `propose_tier1` computes the new proposal's `window_start` exactly as it always would, then checks this one extra condition before accepting.

**This still stops re-proposing the same data:** `window_start` for a Depeg proposal is the start of a window ending at the latest effectively-Final epoch AT THE MOMENT OF THAT CALL. The prior event's own `left_at` is necessarily at or after its own `window_start + depeg_window_secs` (it could not have been proposed, let alone resolved, before its window closed). So:

- An IMMEDIATE re-proposal on unchanged data computes the identical window (no new epoch has become Final since), hence the identical `window_start`, which is `<= left_at` by construction above — rejected.
- A re-proposal before enough NEW epochs have become Final to shift the window's own end past the old window's end cannot produce a `window_start` past `left_at` either, for the same reason: the window only advances as genuinely new Final epochs accumulate.
- Only once enough new data has accumulated that the freshly computed window is built from epochs the FIRST proposal never evaluated does `window_start` move past `left_at` — at which point this is, correctly, no longer "the same data," whether or not the underlying failure is a literal continuation of the same real-world event. The rule cannot distinguish "a brand new depeg" from "the same depeg, still failing, now with 72 more hours of data the first ruling never saw" — and it should not try to: either way, the new proposal is backed by epochs nobody has litigated yet, which is exactly the bar that should allow a fresh look.

IssuerFreeze's `window_start` (start of the earliest counted action in its own 7-day window) advances the same way, for the same reason: a stale re-proposal recomputes the identical window from identical data and is rejected; only new counted actions after `left_at` can move it.

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
- Passes if `clawback_amount_sum / supply >= freeze_pct_bps` (supply from the latest effectively-Final epoch) OR `auth_revocations_sum` above threshold. A counted action governance considers a legitimate compliance action is contested through `challenge`, not excluded from this sum (Section 4, review item D5).
- `window_start` = start of the earliest effectively-Final epoch with a counted action.

Missing data never counts as a trigger in either check: Depeg bounds it by `max_missing_epochs`, IssuerFreeze can only undercount from it. A keeper outage can make a real failure harder to prove, never easier.

## 4. IssuerFreeze gating

**Definition-time gate (unchanged):** `register_definition` rejects IssuerFreeze for an asset whose `issuer_flags` has neither `auth_revocable` nor `clawback_enabled` (`FreezeImpossible`), checked once at registration, never re-checked at `propose_tier1` time.

**Revised (review item D5): no compliance-action exclusion mechanism; dropped.** The first draft of this note designed a governed `exclude_compliance_action`/`is_compliance_excluded` pair. This is removed entirely: a governor-controlled exclusion, callable right up until the moment of a proposal, is an instant, unilateral veto over an IssuerFreeze payout, the one thing this contract's whole bonded-and-timelocked design otherwise refuses to give any single party (Section 8: "every transition is permissionless to trigger, but bonded and time locked"). It would let whoever controls the governor key simply exclude the epochs a proposal is about to rely on, moments before the call, with no bond, no evidence requirement, and no public reasoning beyond a hash.

Section 8.2's own sentence ("no governance flag marks the issuer's action as a declared compliance action") is satisfied through the path that already exists for exactly this kind of disagreement: **`challenge`**. Anyone who believes a counted clawback or revocation was a legitimate, governance-sanctioned compliance action challenges the Tier 1 proposal with evidence (the existing `evidence` argument on `challenge` is where that case, and any published compliance determination, is made); the committee rules with a published `reason_hash` under the ordinary ruling deadline (Section 8.9); on timeout, the Tier 1 default (Declared) applies, exactly as it would for any other contested Tier 1 event. This is strictly slower and more accountable than a standing exclusion flag — bonded, time-bounded, and decided by the committee rather than unilaterally by governance — and needs no new function, storage key, or error code: it is Section 8's own existing challenge/rule/timeout machinery, unchanged.

## 5. Cure (Depeg only)

**Revised (review item D1): the cure window is the CHALLENGE window, not the Depeg window.** `[window_start, window_start + depeg_window_secs)` is the window that already failed the threshold check — that is literally how `propose_tier1` succeeded, so re-checking it for a cure could never pass. "Price recovers" (Section 8.1's own phrase for this transition) has to mean recovers AFTER the proposal, over the epochs that close during the time the proposal sits open and challengeable: `[proposed_at, proposed_at + challenge_secs)`. This is also the only window whose outcome is still undecided data at proposal time — the Depeg window is already fully evaluated and fixed by then.

```
earliest_finalize_at = proposed_at + challenge_secs
```

At that instant, `finalize` requires every epoch in the CURE window (`[proposed_at, proposed_at + challenge_secs)`, by close time) to be present (not permanently missing) and effectively Final before deciding anything.

**Revised (review item D2, corrected again by review item R2): three-way epoch state, so `finalize` cannot stall forever.** Each epoch in the cure window is exactly one of:

- **Final** — effectively Final now (Section 3's own rule): stored state `Final`, or `Pending` with `now >= pending_until`.
- **Permanently missing** — the slot is **`Empty`** (never posted, or posted and then overturned by a lost signal dispute, ADR-010, which moves it back to `Empty` and reopens it for reposting) **AND** `now > epoch_close + window_secs` (the backfill window): a keeper can never legally post this epoch again (`check_epoch_window` itself rejects any post this stale), so it will never become anything but missing. **Revised (review item R2): this is a test on the slot's own STATE, not merely on elapsed time.** The first draft of this note tested only `now > epoch_close + window_secs`, which misclassified a genuinely posted, still-`Pending` epoch (late-posted, `pending_until` not yet reached) as permanently missing purely because enough time had passed since its close — a real, existing posting is never missing, no matter how late it arrived or how far past `window_secs` the CLOCK has moved; only an `Empty` slot can be missing at all.
- **Not ready** — anything else: `Pending` with `now < pending_until` (whether posted on time or backfilled near the deadline), or `Disputed` (open, unresolved — see review item R3 below), or `Empty` but still within its own backfill window (`now <= epoch_close + window_secs`, so a keeper could still post it). It might still reach Final, or might still age into permanently missing (if `Empty`) or resolve one way or the other (if `Disputed`); which one is not yet knowable.

**Revised (review item R3): a `Disputed` epoch is not ready until the dispute resolves or times out.** `effective_state` never auto-converts `Disputed` to `Final` by elapsed time alone (unlike `Pending`); a disputed epoch in the cure window stays "not ready" until either the committee rules (`resolve_signal_dispute`, Section 5.4, ADR-010) or `signal_dispute_ruling_secs` elapses from the dispute's own `opened_at` and anyone calls `resolve_signal_dispute_timeout`. If the keeper wins, the slot becomes Final (effectively-Final check above now applies). If the disputer wins, the slot is overturned back to `Empty`, reopened for reposting — not yet missing, since it can still be posted again inside whatever remains of its own backfill window.

`finalize` proceeds (decides Cured or Declared) once NO epoch in the cure window is "not ready" — every one is either Final or permanently missing. **Revised (review item R1): cure is strict — every epoch in the cure window must be present, effectively Final, and `>= cure_threshold`.** The first draft of this note required only every PRESENT epoch to pass, letting a permanently missing epoch be silently excluded the same way Depeg's own OPENING check tolerates missing data. The review correctly found this lets missing data CREATE a cure (the exact asymmetry Section 8.2 forbids: "missing epochs count neither for nor against" governs whether a FAILURE triggers, not whether a RECOVERY is credited) and, worse, lets a keeper who ALSO sold cover on the series manufacture a cure by simply withholding the epochs that would still show a failing price: post only the epochs that recovered, leave the rest `Empty`, and (under the old rule) a cure would still go through on the partial, favorable data. Corrected: **any permanently missing epoch in the cure window means no cure, unconditionally** — the whole cure check fails and routes to Declared, exactly as if one present epoch had failed the threshold. There is no partial credit for a window the keeper can selectively leave incomplete.

While any epoch in the cure window is still "not ready," `finalize` returns a new error, **`DataNotFinal`**, rather than a silent no-op (so the keeper and monitor can see why `finalize` did not decide anything, instead of guessing at an apparent no-op). `finalize` is callable again later, with no bond or bookkeeping harmed by the earlier, premature call (there is nothing to settle for Tier 1's own unbonded path until a decision is actually reached).

**Latest time an unchallenged event is guaranteed finalizable, as a formula, worst case path (review item R3):** late post, disputed, timed out. The last epoch in the cure window closes just before `proposed_at + challenge_secs`. It is posted at the very latest legal instant (`epoch_close + window_secs`), disputed at the very latest instant its own dispute window still allows (just before `pending_until = posting_time + signal_dispute_secs`), and the dispute is never ruled on, running out its full `signal_dispute_ruling_secs` from `opened_at` before `resolve_signal_dispute_timeout` finally settles it:

```
guaranteed_finalizable_at = proposed_at + challenge_secs + window_secs + signal_dispute_secs + signal_dispute_ruling_secs
```

By this time, every epoch in the cure window is necessarily Final (whether it posted cleanly, or was disputed and resolved by ruling or timeout) or permanently missing (an `Empty` slot whose own `window_secs` has elapsed); there is no remaining "not ready" epoch, so `finalize` is guaranteed to decide (Cured or Declared), never `DataNotFinal`, from this instant onward. At the defaults (`challenge_secs` = 24h, `window_secs` = 72h, `signal_dispute_secs` = 2h, `signal_dispute_ruling_secs` = 168h / 7 days), that is `proposed_at` + 266 hours (just over 11 days).

Once every cure-window epoch is Final or permanently missing: if even one is permanently missing, or any Final epoch is below `cure_threshold` → Declared. Only if EVERY epoch in the cure window is Final AND `>= cure_threshold`, with zero permanently missing, → Cured. (The original Depeg condition already held at proposal time; an incomplete, partial, or withheld recovery does not undo that — Declared is the result any time the cure window's own data cannot fully vouch for a recovery, not only when it affirmatively shows a failure.)

## 6. RiskOracle flag (lead decision)

One asset can have several (kind, version) events live at once, but `set_event_in_progress` is one boolean. `EventRegistry` keeps `ActiveCount(asset)` (persistent, new key) instead of pushing the boolean directly off its own transitions:

- Entering Proposed/Escalated: increment; push `true` only on 0 → 1.
- Leaving those states (Declared, Cured, Rejected, or back to None): decrement; push `false` only on nonzero → 0.
- On Declared specifically: call `set_event_band(asset)` BEFORE decrementing (Section 8.5's own step order: band set, then bonds, then event) — `set_event_band`'s `Event` floor is stronger than `set_event_in_progress`'s `Distress` floor, so setting it first means the band is never briefly under-floored between the two calls.

New read: `active_event_count(asset) -> u32`.

**Invariant E4:** after every call, `RiskOracle`'s own stored `event_in_progress(asset)` flag equals `active_event_count(asset) > 0`. **Revised (review item D6): `RiskOracle` gains a read-only `event_in_progress(asset) -> bool`** (the one `RiskOracle` change in scope for this feature, approved by the review), so E4 is tested by reading the flag directly rather than inferring it through `band()`'s own floor side effect, which the first draft of this note relied on and which cannot distinguish the flag's own effect from a band that is already `Distress` or `Event` for unrelated, price-driven reasons. Tested per transition, by the property test after every op across 2 assets, and by a dedicated scenario (two kinds live, one rejected, flag stays true) — the exact case a naive boolean push would get wrong.

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
4. Any clawback/revocation in the last 7 days → `RecentIssuerAction`.
5. Otherwise → `Clear`.

## 9. Invariants

| Id | Invariant | Primary test |
| --- | --- | --- |
| E1 | Declared only via unchallenged `finalize`, `rule(declare=true)`, or Tier 1 `resolve_timeout` | One unit test per path; property test asserts no other sequence reaches Declared |
| E2 | Declared is terminal | Every other function on an already-Declared event returns `WrongState` |
| E3 | At most one non-terminal event per (asset, kind, version) | Unit test: second `propose_tier1` while one is live returns `EventInProgress`; property test keeps a shadow map |
| E4 | Oracle flag == (active count > 0) | Section 6 |
| E5 | Every bond settles exactly once | Section 7 |
| E6 | An asset's band reaches `Event` only via a Declared event on the canonical version (review item D7) | Unit test: `set_event_band` is called only from the Declared transition for a canonical-version event (Section 2's own D3.b restriction); property test asserts `band(asset) == Event` only when `has_declared(asset)` is true for some kind at its own canonical version |

I13 (every live series pins the current canonical version) is unaffected: it constrains what a SERIES pins at open time, never what a PROPOSAL may target, so it coexists with Section 2's own decision. I7's prose ("committee `rule` before the ruling deadline") should gain an explicit `declare = true` qualifier once this reconciles with code; not a behavior change.

## 10. Attacks

| Attack | What stops it |
| --- | --- |
| Single-epoch price wick | Every present epoch in the 72-epoch window must fail, not a minimum; `peg_ratio_p10` already filters wicks out of the score separately |
| Keeper outage creating gaps | `max_missing_epochs` tolerates a bounded gap; beyond it the proposal fails closed, never passes on absence |
| Liquidity collapse during a real failure (must still trigger) | Liquidity floor checks only the 7-day baseline BEFORE the window, never liquidity inside it |
| Challenger griefing a valid event | Challenger's own bond is the entire stake; losing a ruling forfeits 100% to Treasury |
| Seller forcing a cure with a brief spike | Cure needs every epoch in the full CURE (challenge) window at or above `cure_threshold`, not a moment; one epoch still below routes to Declared |
| A keeper who also sold cover withholds the still-failing epochs to manufacture a cure (review item R1) | Cure is strict: any permanently missing epoch in the cure window, no matter how favorable the present ones look, means no cure at all — routes to Declared unconditionally. There is no partial-data cure to engineer by selective withholding |
| A free proposal against a superseded, looser version (review item D3, D8) | `propose_tier1` accepts only the canonical version or a version pinned by a live series (via `version_has_live_cover`, currently always false with no `MarketFactory`); in this phase every proposal is canonical-only, so there is no looser, superseded definition to exploit for a free, asset-wide `Event` band |
| Keeper outage spanning the cure window (review item D2, D8) | A stretch of permanently-missing epochs cannot stall `finalize`: it decides once every epoch resolves to Final or permanently missing, and (review item R1) any permanently-missing epoch forces the outcome to Declared rather than leaving the event stuck or wrongly cured |
| A genuine failure starting during the old cooldown period (review item D4, D8) | There is no fixed cooldown to fall outside of: a new proposal is accepted as soon as its own freshly computed `window_start` moves past the prior event's `left_at`, which happens as soon as real, unlitigated data exists, regardless of how little time has passed |
| The governor trying to block an IssuerFreeze payout (review item D5, D8) | There is no exclusion flag for governance to call; the only path to contest a counted action is `challenge`, bonded and ruled by the committee under the public ruling deadline, not a unilateral governor call |
| Proposing against a version no series uses | Moot under D3: a non-canonical version is not acceptable at all unless a live series pins it, so there is no version left to propose against that nothing covers |
| Two kinds in progress, one rejected | Exactly Section 6's own motivating case: the count stays above zero, oracle flag stays true |

## 11. Test plan

Unit: every function and error path (`register_definition`'s 7 rejections; `propose_tier1` for both kinds, each branch of Section 3, plus D3's version-acceptance rule, canonical and rejected-non-canonical; `finalize`'s 3-way epoch state and `DataNotFinal` (D2); `challenge`/`rule`/`resolve_timeout` and their failure modes from Section 1, 7; every Section 12.2 read including `cover_gate`'s 5 outcomes, `covers`'s 4 conditions, and the new `RiskOracle.event_in_progress` read (D6)).

Scenario: the day-88-of-90 depeg (Section 8.6); a ruling-deadline timeout for each Tier 1 default; a definition change with a live series still on the old version, proving Section 2's own decision; two kinds live with one rejected (Section 6, 10); a cure attempted mid-backfill, `DataNotFinal` returned, then completed once the gap resolves (Section 5); a cure window with one permanently-missing epoch and every other epoch above `cure_threshold` routes to Declared, not Cured (review item R1, the withholding attack); a late-posted, still-Pending epoch in the cure window returns `DataNotFinal`, never Cured or Declared, until it resolves (review item R2); a Disputed epoch in the cure window returns `DataNotFinal` until the dispute is ruled or times out, then decides correctly (review item R3); `finalize` called at exactly `guaranteed_finalizable_at` always decides; a re-proposal of the same data immediately after Rejected, rejected, followed by a re-proposal once genuinely new data exists, accepted (Section 2a); a proposal against a superseded version with no live series pinning it, rejected (Section 2, 10); a challenged IssuerFreeze proposal where the challenger's own evidence is a compliance determination, ruled by the committee (Section 4, 10).

Property (`proptest`, matching `staking`/`treasury`'s own convention): random `propose_tier1` (both kinds, random registered versions, including non-canonical ones to exercise D3's rejection), `challenge`, `rule`, `resolve_timeout`, `register_definition`, across 2 assets and both kinds, asserting E1 to E4 and E6 after every step. E5 is structural, not fuzzed, matching how this workspace already documents rather than fuzzes its other structurally-provable invariants.

**Integration: confirmed, will use the real `RiskOracle`, `Staking` and `Treasury`**, matching `staking::test::integration`'s own existing convention. Full cycle: real asset, keeper posts a genuine depeg pattern, `propose_tier1` against real oracle data, unchallenged `finalize` to Declared with real `set_event_band`/`set_event_in_progress` calls observed; a separate challenged path with a real `Staking` bond, ruled by a committee address, confirming the loser's forfeited bond reaches `Treasury`'s `Slashed` bucket via a real `deposit` (ADR-012). Every balance asserted at the end.

## 12. Deviations, with reasons

1. **`propose_tier1` takes an explicit `version`** (Section 2): the task's own lead decision, overriding Section 8.1/8.2/8.8 and ADR-001's "(asset, kind) only, always canonical." Narrowed by item 9 below (review item D3): accepted only if canonical or live-series-pinned, not any registered version.
2. **The cure window is the challenge window, not the Depeg window** (Section 5, review item D1): Section 8.1's own "price recovers" can only mean recovery measured over data that postdates the proposal; the Depeg window itself is already-evaluated, fixed, failing data by the time a cure could be considered.
3. **`finalize` on a not-yet-decidable cure window returns `DataNotFinal`, not a no-op** (Section 5, review item D2): the first draft of this note used a silent no-op. The review correctly found that an epoch in the cure window can itself age past ITS OWN backfill window (a keeper outage spanning more than `window_secs` during the challenge window is enough) and become permanently missing — a state a bare "Pending, try later" no-op has no way to distinguish from "will arrive eventually," so it would wait on a result that can never come. `DataNotFinal` is a new error code, and the three-way epoch state (Final / permanently missing / not ready) is what lets `finalize` tell the two cases apart and still decide once every epoch resolves one way or the other.
4. **Cure is strict: any permanently missing epoch in the cure window forces Declared, with no partial credit** (Section 5, review item R1): the second draft of this note required only every PRESENT epoch to pass. The re-review correctly found this lets missing data CREATE a cure, and specifically lets a keeper who also sold cover on the asset manufacture one by withholding exactly the epochs that would still show a failing price. Corrected: one permanently missing epoch anywhere in the cure window is enough to rule out a cure, unconditionally.
5. **"Permanently missing" tests the slot's own state (`Empty`), not elapsed time alone** (Section 5, review item R2): the second draft of this note tested only `now > epoch_close + window_secs`, which misclassified a genuinely posted, still-`Pending` epoch (late-posted, `pending_until` not yet reached) as permanently missing. Corrected: missing requires the slot to be `Empty` AND past its own backfill window; a real posting, however late or however Pending, is never missing.
6. **A `Disputed` epoch in the cure window is "not ready" until resolved or timed out** (Section 5, review item R3): the second draft of this note's `guaranteed_finalizable_at` formula did not account for a dispute opened on a late-posted cure-window epoch. `effective_state` never converts `Disputed` to `Final` by elapsed time alone (unlike `Pending`), so the formula now also adds `signal_dispute_ruling_secs`, covering the worst-case path (late post, dispute, timeout): `proposed_at + challenge_secs + window_secs + signal_dispute_secs + signal_dispute_ruling_secs`, 266 hours (just over 11 days) at the defaults.
7. **`version_has_live_cover` and canonical-only acceptance** (Section 2, review item D3): the first draft of this note treated "every non-canonical version proposable" as the SAFE default; the review correctly identified this as the dangerous direction, since `Event` is sticky and asset-wide while Tier 1 posts no bond, so a superseded, looser definition could be proposed for free. Corrected to canonical-only until `MarketFactory` can confirm a real, live pin.
8. **Asset-wide effects gated to the canonical version** (Section 2, review item D3b): `ActiveCount`, the oracle push, and `set_event_band` now fire only for a canonical-version event; a non-canonical one (reachable only once `MarketFactory` exists) affects only the series pinned to it.
9. **No time-based cooldown; re-proposal gated by `window_start > left_at`** (Section 2a, review item D4): the first draft of this note used a fixed `cooldown_secs`. The review correctly identified that a fixed window could push a genuinely continuing failure past a series' own acceptance period. Replaced with a data-freshness test that needs no duration constant at all.
10. **No compliance-action exclusion mechanism** (Section 4, review item D5): the first draft of this note invented a governed `exclude_compliance_action`/`is_compliance_excluded` pair. The review correctly identified this as an unbonded, unilateral governor veto over a payout decision, exactly what the rest of this contract's design refuses to give any one party. Section 8.2's own sentence is instead satisfied by the existing `challenge`/`rule`/`resolve_timeout` path.
11. **`ActiveCount(asset)` replaces a boolean push** (Section 6): the task's own lead decision; Section 8.1's own prose ("while ANY event... is in progress") already implied this, a plain boolean just could not express it correctly for more than one live event.
12. **`RiskOracle` gains `event_in_progress(asset) -> bool`, a read-only function** (Section 9, review item D6): the one `RiskOracle` change this note's scope allows, approved explicitly by the review. Replaces the first draft's band-floor-based inference for testing E4.
13. **New invariant E6** (Section 9, review item D7): an asset's band reaches `Event` only via a Declared event on the canonical version — the natural companion to item 8 above, stated as its own tested invariant rather than left implicit in the version-gating rule.
14. **I7's wording gap** (Section 9): a precision note, not a behavior change.
15. **Retirement is a no-op until `MarketFactory` exists** (Section 2): the task's own explicit instruction, now narrowed by item 7's own canonical-only default rather than the first draft's "every non-canonical version proposable" default.

No other part of the cited source of truth required a deviation; the rest of Section 8 and 12.2 maps onto this design directly.
