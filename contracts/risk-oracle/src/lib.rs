#![no_std]

//! RiskOracle: stores per asset signals per epoch, computes the score,
//! exposes bands and staleness. technical-doc.md Section 5, 6.
//!
//! Scope: everything in Section 12.1 except the parts that need
//! `EventRegistry`'s cover gate / event-in-progress state, which
//! `RiskOracle` has no API path to read (see "Known gaps" in the PR
//! description). `Staking`, the `PriceAdapter`/`FxAdapter` adapters and
//! `Governor`'s committee lookup are called through minimal client
//! interfaces (`clients.rs`); none of those contracts are implemented
//! here.

mod clients;
mod error;
mod events;
mod math;
mod score;
mod storage;

use soroban_sdk::{contract, contractimpl, symbol_short, Address, BytesN, Env, Map, Symbol, Vec};
use sylox_types::{AssetConfig, Band, EndpointStatus, RingSlot, RiskScore, SignalSet, SCALE};

use clients::{FxAdapterClient, GovernorClient, PriceAdapterClient, StakingClient};
pub use error::Error;
use score::{Formula, AGGREGATE_SLOTS_7D};
use storage::DisputeRecord;

/// Signal posting window: how far back a closed epoch may still be posted.
/// technical-doc.md Section 5.2, Section 23 `window_secs` default.
const WINDOW_SECS: u64 = 259_200;

/// Default epoch length. technical-doc.md Section 23 `epoch_secs`. Frozen
/// for v1 alongside `storage::RING_SLOTS`, not a governance parameter: see
/// the PR's "Spec deviations" section.
const EPOCH_SECS: u64 = 3_600;

/// Default signal dispute window. technical-doc.md Section 23
/// `signal_dispute_secs`.
const SIGNAL_DISPUTE_SECS: u64 = 7_200;

/// ADR-010 (feat/staking, issue #4 fix): how long the committee has to
/// rule on an open signal dispute, from `dispute_signals`, before
/// `resolve_signal_dispute_timeout` becomes callable. Default 7 days,
/// matching ADR-002's `ruling_deadline_secs` precedent for event
/// disputes, though shorter: a signal dispute's underlying question
/// (what did the endpoint report) is far narrower than an event
/// definition's.
const SIGNAL_DISPUTE_RULING_SECS: u64 = 604_800;

/// technical-doc.md Section 23 `stale_after_epochs` default.
const STALE_AFTER_EPOCHS: u64 = 3;

/// technical-doc.md Section 23 `band_down_epochs` default.
const BAND_DOWN_EPOCHS: u32 = 3;

/// Review item C6 (re-review): every state-changing call's finality
/// scan (`try_advance_finality`) looks back across the full backfill
/// window, `WINDOW_SECS / EPOCH_SECS + 1` epochs (73 at the defaults),
/// never more than `RING_SLOTS` (nothing older could still be
/// physically present). This is a fixed bound per call, not a
/// sequential cursor that only advances one epoch per call: a single
/// call can now observe and announce every epoch across the whole
/// window that just became final, matching the re-review's "scan
/// back... bounded by the ring" instruction.
const FINALITY_LOOKBACK_EPOCHS: u32 = (WINDOW_SECS / EPOCH_SECS) as u32 + 1;

/// technical-doc.md Section 23 `amm_tolerance_bps` default.
const AMM_TOLERANCE_BPS: i128 = 300;

/// Median liquidity window for `median_liquidity` (Section 11.1) and the
/// score's 7 day aggregates (Section 6.5): the newest 168 of the ring's
/// 240 slots.
const MEDIAN_WINDOW_SLOTS: u32 = 168;

/// Section 11.3's `liquidity_2pct`, `supply` upper bound.
const MAX_LIQUIDITY_OR_SUPPLY: i128 = i128::MAX / SCALE;

/// Section 11.3's `supply_change_bps` consistency tolerance.
const SUPPLY_CHANGE_TOLERANCE_BPS: i128 = 1;

#[contract]
pub struct RiskOracle;

#[contractimpl]
impl RiskOracle {
    /// technical-doc.md Section 12.1.
    pub fn initialize(
        env: Env,
        governor: Address,
        registry: Address,
        staking: Address,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&CONFIG_KEY) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(
            &CONFIG_KEY,
            &Config {
                governor,
                registry,
                staking,
            },
        );
        storage::set_formula(&env, &score::default_formula(&env));
        Ok(())
    }

    /// technical-doc.md Section 12.1. Rejects an asset that is already
    /// registered (`update_asset` is for changing one). Review decision
    /// D3: also rejects `Reference::Asset` (no USD rate is defined
    /// anywhere in the spec for an asset pegged reference; see the PR's
    /// "Spec deviations").
    pub fn add_asset(env: Env, cfg: AssetConfig) -> Result<(), Error> {
        let config = Self::require_config(&env)?;
        config.governor.require_auth();
        reject_asset_reference(&cfg.reference)?;
        if storage::get_asset_config(&env, &cfg.asset).is_some() {
            return Err(Error::AlreadyInitialized);
        }
        storage::set_asset_config(&env, &cfg.asset, &cfg);
        storage::add_to_asset_list(&env, &cfg.asset);
        Ok(())
    }

    /// technical-doc.md Section 12.1: "rejects a change to cfg.reference".
    /// Review decision D3: also rejects `Reference::Asset`, same as
    /// `add_asset` (an existing asset can never have had this reference
    /// in the first place, since `add_asset` rejects it, but the check
    /// is repeated here rather than relying on that invariant holding
    /// forever).
    pub fn update_asset(env: Env, asset: Address, cfg: AssetConfig) -> Result<(), Error> {
        let config = Self::require_config(&env)?;
        config.governor.require_auth();
        reject_asset_reference(&cfg.reference)?;
        let existing = storage::get_asset_config(&env, &asset).ok_or(Error::UnknownAsset)?;
        if existing.reference != cfg.reference {
            return Err(Error::ReferenceImmutable);
        }
        storage::set_asset_config(&env, &asset, &cfg);
        Ok(())
    }

    /// technical-doc.md Section 12.1.
    pub fn disable_asset(env: Env, asset: Address) -> Result<(), Error> {
        let config = Self::require_config(&env)?;
        config.governor.require_auth();
        let mut cfg = storage::get_asset_config(&env, &asset).ok_or(Error::UnknownAsset)?;
        cfg.enabled = false;
        storage::set_asset_config(&env, &asset, &cfg);
        Ok(())
    }

    /// technical-doc.md Section 12.1, 5.2, 5.3, 11.3.
    ///
    /// Checks keeper eligibility against `Staking`, applies the full
    /// Section 11.3 sanity bounds, cross checks configured `PriceAdapter`s,
    /// and sources `endpoint` only from `Staking.aggregate` (never the
    /// keeper's payload). `s.endpoint` is only ever a placeholder on input.
    pub fn post_signals(
        env: Env,
        keeper: Address,
        asset: Address,
        mut s: SignalSet,
    ) -> Result<(), Error> {
        keeper.require_auth();

        let config = Self::require_config(&env)?;
        if !StakingClient::new(&env, &config.staking).is_active_keeper(&keeper) {
            return Err(Error::KeeperNotActive);
        }

        let cfg = storage::get_asset_config(&env, &asset).ok_or(Error::UnknownAsset)?;
        if !cfg.enabled {
            return Err(Error::UnknownAsset);
        }

        let now = env.ledger().timestamp();
        check_epoch_window(s.epoch, now)?;
        if storage::get_signals(&env, &asset, s.epoch).is_some() {
            // Review item C4: an epoch that was overturned by a resolved
            // dispute has already been moved out of here (to the
            // Overturned history key, by resolve_signal_dispute), so
            // get_signals no longer finds it and this check does not
            // block a repost for it. Any OTHER existing posting for this
            // epoch (Pending, Disputed or still Final) blocks a repost,
            // matching Section 11.3.
            return Err(Error::EpochAlreadyPosted);
        }
        check_sanity_bounds(&s)?;
        check_supply_change_consistency(&env, &asset, &s)?;
        check_amm_cross_check(&env, &cfg, &s)?;

        s.poster = keeper.clone();
        s.posted_at = now;
        s.endpoint = StakingClient::new(&env, &config.staking).aggregate(&asset, &s.epoch);

        storage::set_signals(&env, &asset, s.epoch, &s);

        let pending_until = now + SIGNAL_DISPUTE_SECS;
        let wrote = storage::write_ring_slot(&env, &asset, s.epoch, &s, pending_until);
        if !wrote {
            // The ring position for this epoch already holds a strictly
            // newer epoch (the buffer wrapped past it). check_epoch_window
            // should already reject a posting this stale via WINDOW_SECS;
            // reaching here would mean the two checks have drifted apart.
            return Err(Error::WrongEpoch);
        }

        events::SignalsPosted {
            asset: asset.clone(),
            epoch: s.epoch,
            keeper,
            inputs_hash: s.inputs_hash.clone(),
            pending_until,
        }
        .publish(&env);

        // Review items C1, C5, C6: this posting cannot itself be final
        // yet (pending_until is always in the future at post time),
        // but posting is also the natural moment to sweep the whole
        // backfill window for any OLDER epoch that has quietly
        // crossed finality since the last state changing call touched
        // it ("on backfill" in review item C1's wording).
        if let Some(newest_final) = try_advance_finality(&env, &asset, FINALITY_LOOKBACK_EPOCHS) {
            recompute_score(&env, &asset, newest_final)?;
        }
        check_stale_internal(&env, &asset)?;

        Ok(())
    }

    /// technical-doc.md Section 12.1, 5.4, 7.8.
    ///
    /// Records the dispute and locks the disputer's bond in `Staking`.
    /// Only the signal dispute STATE lives here; the bond itself is held
    /// and later split by `Staking` on instruction from
    /// `resolve_signal_dispute`.
    pub fn dispute_signals(
        env: Env,
        disputer: Address,
        asset: Address,
        epoch: u64,
        alt_hash: BytesN<32>,
    ) -> Result<(), Error> {
        disputer.require_auth();
        let config = Self::require_config(&env)?;

        let slot = storage::get_slot(&env, &asset, epoch).ok_or(Error::WrongEpoch)?;
        if slot.state != sylox_types::SlotState::Pending {
            // Only a Pending posting can still be disputed; Final is past
            // the window, Disputed already has an open dispute, Empty has
            // nothing to dispute.
            return Err(Error::DisputeWindowClosed);
        }
        if env.ledger().timestamp() >= slot.pending_until {
            return Err(Error::DisputeWindowClosed);
        }
        if storage::get_dispute(&env, &asset, epoch).is_some() {
            return Err(Error::DisputeWindowClosed);
        }
        let signals = storage::get_signals(&env, &asset, epoch).ok_or(Error::WrongEpoch)?;

        let bond = signal_dispute_bond();
        let now = env.ledger().timestamp();
        StakingClient::new(&env, &config.staking).lock_bond(
            &sylox_types::BondKey::SignalDispute(asset.clone(), epoch),
            &disputer,
            &bond,
            &Some(signals.poster.clone()),
        );
        storage::set_dispute(
            &env,
            &asset,
            epoch,
            &DisputeRecord {
                disputer: disputer.clone(),
                alt_hash: alt_hash.clone(),
                opened_at: now,
            },
        );
        storage::set_slot_disputed(&env, &asset, epoch);

        events::SignalsDisputed {
            asset: asset.clone(),
            epoch,
            disputer,
            alt_hash,
        }
        .publish(&env);
        check_stale_internal(&env, &asset)?;
        Ok(())
    }

    /// technical-doc.md Section 12.1, 5.4, 7.8. Auth: the committee
    /// address, read fresh from `Governor.committee()` on every call (the
    /// committee can rotate; `RiskOracle` never caches it).
    pub fn resolve_signal_dispute(
        env: Env,
        asset: Address,
        epoch: u64,
        keeper_wins: bool,
        reason: BytesN<32>,
    ) -> Result<(), Error> {
        let config = Self::require_config(&env)?;
        let committee = GovernorClient::new(&env, &config.governor).committee();
        committee.require_auth();
        let _ = &reason; // stored only by EventRegistry-style callers in Phase 3; RiskOracle has nowhere to persist it yet (known gap).

        let dispute =
            storage::get_dispute(&env, &asset, epoch).ok_or(Error::DisputeWindowClosed)?;
        let signals = storage::get_signals(&env, &asset, epoch).ok_or(Error::WrongEpoch)?;
        let staking = StakingClient::new(&env, &config.staking);
        let bond_key = sylox_types::BondKey::SignalDispute(asset.clone(), epoch);

        if keeper_wins {
            staking.forfeit_bond(&bond_key, &Some(signals.poster.clone()));
            // Review item C6 (re-review): the slot is now immediately,
            // definitely Final, decided right here, not merely
            // "effectively" final pending a clock check elsewhere.
            // set_slot_final sets the final_announced flag in the same
            // write that sets the state, per the re-review's "emit
            // signals_final immediately and set the flag in the same
            // write" instruction; this contract then emits the event
            // for THIS epoch directly, rather than waiting for the
            // independent backward scan below (which exists to pick up
            // any OTHER epoch this resolution may have unblocked, not
            // this one).
            if storage::set_slot_final(&env, &asset, epoch) {
                events::SignalsFinal {
                    asset: asset.clone(),
                    epoch,
                }
                .publish(&env);
            }
            if let Some(newest_final) = try_advance_finality(&env, &asset, FINALITY_LOOKBACK_EPOCHS)
            {
                recompute_score(&env, &asset, newest_final)?;
            }
        } else {
            staking.release_bond(&bond_key);
            staking.slash(
                &signals.poster,
                &keeper_slash(),
                &Some(dispute.disputer.clone()),
                &BytesN::from_array(&env, &[0u8; 32]),
            );
            storage::set_slot_overturned(&env, &asset, epoch);
            // Review item C4: move the overturned Signals entry to
            // history so post_signals accepts a fresh posting for this
            // same epoch (ADR-005: "an overturned epoch reopens for
            // reposting").
            storage::overturn_signals(&env, &asset, epoch);
            // Review item C6 (re-review): an overturned epoch, even if
            // never reposted, must not block any LATER epoch's
            // finality. The independent backward scan already
            // guarantees this by construction (it skips past this
            // epoch, now Empty, without stopping), but a resolution
            // can still be the event that unblocks something later
            // that was waiting on this one, so sweep here too.
            if let Some(newest_final) = try_advance_finality(&env, &asset, FINALITY_LOOKBACK_EPOCHS)
            {
                recompute_score(&env, &asset, newest_final)?;
            }
        }
        storage::clear_dispute(&env, &asset, epoch);

        events::SignalsResolved {
            asset: asset.clone(),
            epoch,
            keeper_wins,
            reason,
        }
        .publish(&env);
        check_stale_internal(&env, &asset)?;
        Ok(())
    }

    /// ADR-010 (issue #4 fix). Permissionless, callable once
    /// `SIGNAL_DISPUTE_RULING_SECS` has passed since `dispute_signals`
    /// opened this dispute, if the committee still has not ruled via
    /// `resolve_signal_dispute`. Default outcome mirrors ADR-002's
    /// rule for data backed claims: the keeper's posting stands (slot
    /// `Final`, same as a `keeper_wins: true` committee ruling). "Both
    /// bonds released in full, nobody slashed" (the task's own
    /// wording): there is only one actual `BondKey::SignalDispute`
    /// lock to release, the disputer's (technical-doc.md Section 24.2
    /// notes a keeper has no symmetric per-signal bond in v1; only
    /// `slash`, by address, ever touches a keeper's stake), so in
    /// practice this means the disputer's bond is refunded
    /// (`release_bond`, not `forfeit_bond`) AND the keeper's stake is
    /// left untouched (no `slash` call either) — both parties come
    /// out exactly as they would from a `keeper_wins: true` ruling,
    /// which is the committee's silence being read as "no evidence
    /// the posting was wrong", not as a loss for either side.
    pub fn resolve_signal_dispute_timeout(
        env: Env,
        asset: Address,
        epoch: u64,
    ) -> Result<(), Error> {
        let config = Self::require_config(&env)?;
        let dispute =
            storage::get_dispute(&env, &asset, epoch).ok_or(Error::DisputeWindowClosed)?;
        let now = env.ledger().timestamp();
        if now < dispute.opened_at + SIGNAL_DISPUTE_RULING_SECS {
            return Err(Error::RulingDeadlineNotReached);
        }

        let staking = StakingClient::new(&env, &config.staking);
        let bond_key = sylox_types::BondKey::SignalDispute(asset.clone(), epoch);
        staking.release_bond(&bond_key);
        if storage::set_slot_final(&env, &asset, epoch) {
            events::SignalsFinal {
                asset: asset.clone(),
                epoch,
            }
            .publish(&env);
        }
        if let Some(newest_final) = try_advance_finality(&env, &asset, FINALITY_LOOKBACK_EPOCHS) {
            recompute_score(&env, &asset, newest_final)?;
        }
        storage::clear_dispute(&env, &asset, epoch);

        let committee = GovernorClient::new(&env, &config.governor).committee();
        storage::record_committee_miss(&env, &committee);

        events::SignalDisputeTimedOut {
            asset: asset.clone(),
            epoch,
            disputer: dispute.disputer,
            committee,
        }
        .publish(&env);
        check_stale_internal(&env, &asset)?;
        Ok(())
    }

    /// technical-doc.md Section 12.1, 7.4. Reads `Staking.aggregate` and
    /// books it into the epoch's ring slot and `Signals` entry if
    /// `post_signals` had not already resolved one by the time it closed;
    /// then calls `Staking.settle_probes` exactly once regardless, per
    /// Section 7.4's "booked exactly once" requirement.
    pub fn finalize_endpoint(env: Env, asset: Address, epoch: u64) -> Result<(), Error> {
        let config = Self::require_config(&env)?;
        let now = env.ledger().timestamp();
        let epoch_close = (epoch + 1) * EPOCH_SECS;
        if now < epoch_close {
            return Err(Error::WrongEpoch);
        }

        let staking = StakingClient::new(&env, &config.staking);
        let aggregate = staking.aggregate(&asset, &epoch);

        if let Some(mut signals) = storage::get_signals(&env, &asset, epoch) {
            if signals.endpoint == EndpointStatus::Unknown {
                signals.endpoint = aggregate;
                storage::set_signals(&env, &asset, epoch, &signals);
                storage::set_slot_endpoint(&env, &asset, epoch, aggregate);
                events::EndpointFinalized {
                    asset: asset.clone(),
                    epoch,
                    status: aggregate,
                }
                .publish(&env);
            }
        }
        staking.settle_probes(&asset, &epoch);

        // finalize_endpoint is the one permissionless, callable-by-anyone
        // function guaranteed to run after an epoch's dispute window has
        // had time to elapse (the caller only needs the epoch itself to
        // have closed, Section 7.4), so it is also where review item C1
        // and C5's lazy finality sweep gets a chance to run even if no
        // new SignalSet is ever posted for a later epoch on this asset.
        if let Some(newest_final) = try_advance_finality(&env, &asset, FINALITY_LOOKBACK_EPOCHS) {
            recompute_score(&env, &asset, newest_final)?;
        }
        check_stale_internal(&env, &asset)?;
        Ok(())
    }

    /// technical-doc.md Section 12.1, 8.5, 8.8. Auth: the registry
    /// contract itself (the `registry` address `RiskOracle` was
    /// initialized with), per Section 16.1's contract-to-contract auth
    /// pattern.
    pub fn set_event_band(env: Env, asset: Address) -> Result<(), Error> {
        let config = Self::require_config(&env)?;
        config.registry.require_auth();
        let mut score = storage::get_score(&env, &asset).unwrap_or(RiskScore {
            epoch: 0,
            score: 0,
            band: Band::Normal,
            formula_version: 0,
            stale: true,
        });
        score.band = Band::Event;
        storage::set_score(&env, &asset, &score);
        storage::set_down_streak(&env, &asset, 0);
        Ok(())
    }

    /// technical-doc.md Section 12.1, 8.8.
    pub fn clear_event_band(env: Env, asset: Address) -> Result<(), Error> {
        let config = Self::require_config(&env)?;
        config.registry.require_auth();
        let mut score = storage::get_score(&env, &asset).ok_or(Error::UnknownAsset)?;
        score.band = score::band_for_score(score.score);
        storage::set_score(&env, &asset, &score);
        Ok(())
    }

    /// Review decision D1, not in the original Section 12.1 list. Auth:
    /// the registry contract, same pattern as `set_event_band` /
    /// `clear_event_band` (Section 16.1). While `true`, `score()` floors
    /// the band at `Distress` on every read (Section 6.3's "forced to
    /// Distress if a credit event... is Proposed, Challenged or
    /// Escalated"), independent of the hysteresis-protected band
    /// actually stored; `RiskOracle` never calls into `EventRegistry` to
    /// check this itself, matching the instruction that "the oracle
    /// never calls the registry" — this is pushed in, the same
    /// direction `set_event_band` already works.
    pub fn set_event_in_progress(env: Env, asset: Address, in_progress: bool) -> Result<(), Error> {
        let config = Self::require_config(&env)?;
        config.registry.require_auth();
        storage::set_event_in_progress(&env, &asset, in_progress);
        // No recompute needed: `score()` applies this flag as a live
        // floor on every read (see its doc comment), so the change is
        // visible immediately with no write to the stored RiskScore.
        Ok(())
    }

    /// technical-doc.md Section 12.1, 6.2. `set_formula` rejects any
    /// weight set that does not sum to 10,000.
    pub fn set_formula(
        env: Env,
        version: u32,
        weights: Vec<u32>,
        params: Map<Symbol, i128>,
    ) -> Result<(), Error> {
        let config = Self::require_config(&env)?;
        config.governor.require_auth();
        score::validate_weights(&weights)?;
        storage::set_formula(
            &env,
            &Formula {
                version,
                weights,
                params,
            },
        );
        Ok(())
    }

    // -- reads --

    pub fn asset_config(env: Env, asset: Address) -> Option<AssetConfig> {
        storage::get_asset_config(&env, &asset)
    }

    pub fn signals(env: Env, asset: Address, epoch: u64) -> Option<SignalSet> {
        storage::get_signals(&env, &asset, epoch)
    }

    /// Review item C4: the `SignalSet` an overturned epoch's posting had
    /// before `resolve_signal_dispute` moved it out of `signals`'s live
    /// key, kept for audit. `None` if `epoch` was never overturned (or
    /// was overturned, reposted, and overturned again, which keeps only
    /// the most recent overturn, not a full history of every attempt).
    pub fn overturned_signals(env: Env, asset: Address, epoch: u64) -> Option<SignalSet> {
        storage::get_overturned_signals(&env, &asset, epoch)
    }

    pub fn latest(env: Env, asset: Address) -> Option<SignalSet> {
        let newest = storage::get_newest_epoch_pub(&env, &asset)?;
        storage::get_signals(&env, &asset, newest)
    }

    /// technical-doc.md Section 5.8, 12.1: one storage read, oldest slot
    /// first. See `storage::get_ring`'s doc comment for exactly what
    /// "oldest first" means once the buffer has wrapped.
    pub fn ring(env: Env, asset: Address) -> Vec<RingSlot> {
        storage::get_ring(&env, &asset)
    }

    /// Review item C5: whether epoch `epoch` is EFFECTIVELY final right
    /// now: its stored state is `Final`, or it is `Pending` and
    /// `pending_until` has already passed. `false` for a missing epoch.
    pub fn is_final(env: Env, asset: Address, epoch: u64) -> bool {
        let now = env.ledger().timestamp();
        storage::is_final(&env, &asset, epoch, now)
    }

    /// Review item C5: a window read of effective state per epoch, for
    /// `EventRegistry`'s Tier 1 checks (Section 8.2), so it can learn
    /// which epochs in a window are final without one call per epoch.
    /// Missing epochs read `None`, the same convention as `ring`'s
    /// underlying storage.
    pub fn effective_window(
        env: Env,
        asset: Address,
        start_epoch: u64,
        count: u32,
    ) -> Vec<Option<sylox_types::SlotState>> {
        let now = env.ledger().timestamp();
        storage::get_effective_window(&env, &asset, start_epoch, count, now)
    }

    /// technical-doc.md Section 12.1, 6. Review item C1: a PURE read.
    /// Returns whatever `RiskScore` is currently stored, with `stale`
    /// recomputed fresh against the clock (so a score that was fresh
    /// when last written but has since gone quiet is reported stale
    /// without needing a write to say so). Never calls
    /// `storage::set_score` or any other write; the actual computation
    /// happens in `recompute_score`, called from `post_signals`, the
    /// finality sweep, and `finalize_endpoint` (see those for exactly
    /// when).
    ///
    /// Review decision D1: the stored `band` is always the plain
    /// hysteresis band, computed with no knowledge of the event-in-
    /// progress flag (see `recompute_score`), so that flipping the
    /// flag off is never confused with a genuine new epoch of evidence
    /// for the hysteresis streak. The "forced to at least Distress
    /// while in progress" override is applied here instead, on every
    /// read, which also makes it take effect immediately on
    /// `set_event_in_progress` with no recompute required.
    pub fn score(env: Env, asset: Address) -> Result<RiskScore, Error> {
        storage::get_asset_config(&env, &asset).ok_or(Error::UnknownAsset)?;
        let stored = storage::get_score(&env, &asset);
        let newest_final = storage::get_newest_final(&env, &asset);

        let result = match (stored, newest_final) {
            (Some(current), Some(newest_final)) if current.band != Band::Event => RiskScore {
                stale: is_stale_epoch(&env, newest_final),
                ..current
            },
            (Some(current), _) => current, // Event band stays as stored regardless of staleness.
            (None, _) => stale_score(&None),
        };
        if result.band != Band::Event
            && storage::get_event_in_progress(&env, &asset)
            && result.band < Band::Distress
        {
            return Ok(RiskScore {
                band: Band::Distress,
                ..result
            });
        }
        Ok(result)
    }

    pub fn band(env: Env, asset: Address) -> Result<Band, Error> {
        Ok(Self::score(env, asset)?.band)
    }

    /// Re-review item C7 (lead decision): `asset_stale` now means "the
    /// asset TRANSITIONED into stale", not "a newly observed epoch
    /// happened to already be stale on arrival" (the old design's
    /// condition, which never fired at all for the realistic "keepers
    /// stopped posting" case, since nothing new ever arrives to
    /// trigger it). Permissionless: evaluates staleness against the
    /// epoch of the STORED score (never `newest_final`, which can run
    /// ahead of the stored score when `recompute_score` short
    /// circuits without writing, e.g. a sticky `Event` band or not
    /// enough history yet), emits `asset_stale` once if the asset is
    /// stale and `stale_announced` is not already set, sets the flag,
    /// and returns the current stale state either way. Calling this
    /// again while still stale emits nothing. Every state changing
    /// call that touches an asset runs the same check internally (see
    /// `check_stale_internal`), so a late backfill that is stale on
    /// arrival also emits, once, without needing anyone to call this
    /// explicitly; this function exists for a monitor that wants to
    /// poll every asset itself (Section 22.4 in the upcoming spec
    /// v1.2 PR) without waiting for keeper activity to drive it.
    pub fn check_stale(env: Env, asset: Address) -> Result<bool, Error> {
        storage::get_asset_config(&env, &asset).ok_or(Error::UnknownAsset)?;
        check_stale_internal(&env, &asset)
    }

    pub fn is_stale(env: Env, asset: Address) -> bool {
        match storage::get_newest_epoch_pub(&env, &asset) {
            Some(newest) => is_stale_epoch(&env, newest),
            None => true,
        }
    }

    /// technical-doc.md Section 11.1: median of the newest 168 slots'
    /// `liquidity_2pct`, for the asset wide cover cap. Missing slots in
    /// the window are excluded, not treated as zero liquidity, so a short
    /// run of missing epochs does not crater the cap the way real zero
    /// liquidity would.
    pub fn median_liquidity(env: Env, asset: Address) -> i128 {
        let Some(newest) = storage::get_newest_epoch_pub(&env, &asset) else {
            return 0;
        };
        if newest + 1 < MEDIAN_WINDOW_SLOTS as u64 {
            return 0;
        }
        let start = newest + 1 - MEDIAN_WINDOW_SLOTS as u64;
        let window = storage::get_window(&env, &asset, start, MEDIAN_WINDOW_SLOTS);
        let mut liquidity = Vec::new(&env);
        for i in 0..MEDIAN_WINDOW_SLOTS {
            if let Some(slot) = window.get(i).flatten() {
                liquidity.push_back(slot.liquidity_2pct);
            }
        }
        if liquidity.is_empty() {
            0
        } else {
            math::median(&liquidity)
        }
    }

    /// technical-doc.md Section 12.1: reference to USD, SCALE 1e7. `Usd`
    /// is always `SCALE`; `Fiat` reads the asset's `FxAdapter` on the
    /// reference's recorded basis and fails closed on a stale or missing
    /// rate; `Asset` has no USD rate defined anywhere in the spec, so this
    /// fails rather than guessing one (see the PR's "Spec deviations").
    pub fn reference_rate(env: Env, asset: Address) -> Result<i128, Error> {
        let cfg = storage::get_asset_config(&env, &asset).ok_or(Error::UnknownAsset)?;
        match cfg.reference {
            sylox_types::Reference::Usd => Ok(SCALE),
            sylox_types::Reference::Fiat(code, rate_source) => {
                let adapter = cfg.fx_adapter.ok_or(Error::ReferenceRateUnavailable)?;
                let (rate, timestamp) =
                    FxAdapterClient::new(&env, &adapter).rate(&code, &rate_source);
                if is_stale_timestamp(&env, timestamp) {
                    return Err(Error::ReferenceRateUnavailable);
                }
                Ok(rate)
            }
            sylox_types::Reference::Asset(_) => Err(Error::ReferenceRateUnavailable),
        }
    }

    pub fn assets(env: Env) -> Vec<Address> {
        storage::get_assets(&env)
    }

    fn require_config(env: &Env) -> Result<Config, Error> {
        env.storage()
            .instance()
            .get(&CONFIG_KEY)
            .ok_or(Error::NotInitialized)
    }
}

fn stale_score(stored: &Option<RiskScore>) -> RiskScore {
    match stored {
        Some(s) => RiskScore { stale: true, ..*s },
        None => RiskScore {
            epoch: 0,
            score: 0,
            band: Band::Normal,
            formula_version: 0,
            stale: true,
        },
    }
}

fn l_target_for(cfg: &AssetConfig) -> i128 {
    let _ = cfg;
    // Section 6.1: "L_target per asset". AssetConfig has no l_target field
    // in contracts/types as it exists today; see the PR's "Spec
    // deviations" section. A conservative stand-in (min_liquidity, the one
    // per-asset liquidity figure AssetConfig does carry) is used until the
    // type is extended.
    cfg_min_liquidity_as_l_target(cfg)
}

fn cfg_min_liquidity_as_l_target(cfg: &AssetConfig) -> i128 {
    cfg.min_liquidity
}

fn signal_dispute_bond() -> i128 {
    10_000_000_000
}

fn keeper_slash() -> i128 {
    10_000_000_000
}

fn is_stale_timestamp(env: &Env, timestamp: u64) -> bool {
    let now = env.ledger().timestamp();
    now.saturating_sub(timestamp) > STALE_AFTER_EPOCHS * EPOCH_SECS
}

/// technical-doc.md Section 5.5: an asset (or, here, a specific epoch
/// candidate) is stale if more than `stale_after_epochs` epochs have
/// passed since it. Shared by `score()` (a pure read) and
/// `recompute_score` (a write), neither of which is a method so both
/// can call it without going through `Self`.
fn is_stale_epoch(env: &Env, epoch: u64) -> bool {
    let now = env.ledger().timestamp();
    let current_epoch = now / EPOCH_SECS;
    current_epoch.saturating_sub(epoch) > STALE_AFTER_EPOCHS
}

/// Re-review item C7: the shared implementation behind both the
/// public, permissionless `check_stale` and the internal call every
/// state changing function makes on its own asset. Judges staleness
/// against the STORED score's own epoch (a brand new asset with no
/// score at all is stale by definition, matching `score()`'s own
/// `(None, _)` branch), emits `asset_stale` exactly on the transition
/// into stale, and clears `stale_announced` the moment a fresh,
/// non-stale score is on record (no separate "recovered" event:
/// `score_updated` already signals that a fresh score landed).
fn check_stale_internal(env: &Env, asset: &Address) -> Result<bool, Error> {
    let stored = storage::get_score(env, asset);
    let stale = match &stored {
        Some(current) => is_stale_epoch(env, current.epoch),
        None => true,
    };
    let announced = storage::get_stale_announced(env, asset);
    if stale && !announced {
        events::AssetStale {
            asset: asset.clone(),
            last_epoch: stored.map(|s| s.epoch).unwrap_or(0),
        }
        .publish(env);
        storage::set_stale_announced(env, asset, true);
    } else if !stale && announced {
        storage::set_stale_announced(env, asset, false);
    }
    Ok(stale)
}

#[derive(Clone)]
#[soroban_sdk::contracttype]
struct Config {
    governor: Address,
    registry: Address,
    staking: Address,
}

const CONFIG_KEY: Symbol = symbol_short!("CONFIG");

/// technical-doc.md Section 5.2 (backfill), 11.3 (epoch bound). Epoch `n`
/// covers `[n * epoch_secs, (n + 1) * epoch_secs)` from the Unix epoch
/// (`genesis = 0`), approved: epoch numbering is a pure function of
/// ledger time, with no stored genesis to initialize or keep in sync
/// across contracts. See the PR's "Spec deviations" section.
fn check_epoch_window(epoch: u64, now: u64) -> Result<(), Error> {
    let current_epoch = now / EPOCH_SECS;
    if epoch >= current_epoch {
        return Err(Error::WrongEpoch);
    }
    let epoch_close = (epoch + 1) * EPOCH_SECS;
    if now.saturating_sub(epoch_close) > WINDOW_SECS {
        return Err(Error::WrongEpoch);
    }
    Ok(())
}

/// Review decision D3: `Reference::Asset` is rejected in v1. No part of
/// the spec defines a USD rate for an asset pegged reference (it would
/// presumably need that other asset's own `reference_rate`, recursively,
/// but nothing bounds how deep that could go); see the PR's "Spec
/// deviations" section.
fn reject_asset_reference(reference: &sylox_types::Reference) -> Result<(), Error> {
    if matches!(reference, sylox_types::Reference::Asset(_)) {
        return Err(Error::ReferenceNotSupported);
    }
    Ok(())
}

/// technical-doc.md Section 11.3, the bounds that do not need the ring:
/// - `peg_ratio`, `peg_ratio_p10`: 0 to 2 * SCALE each, and (per the
///   reviewer's required change) `peg_ratio_p10 <= peg_ratio`. Flagged in
///   the PR description: Section 11.3's own text says explicitly "No
///   ordering between them: a 10th percentile can sit above a volume
///   weighted mean when a few large trades print far below the rest",
///   which this check contradicts; implemented per the explicit review
///   instruction, not silently.
/// - `liquidity_2pct`, `supply`: 0 to `i128::MAX / SCALE`.
fn check_sanity_bounds(s: &SignalSet) -> Result<(), Error> {
    if s.peg_ratio < 0 || s.peg_ratio > 2 * SCALE {
        return Err(Error::SanityBoundFailed);
    }
    if s.peg_ratio_p10 < 0 || s.peg_ratio_p10 > 2 * SCALE {
        return Err(Error::SanityBoundFailed);
    }
    if s.peg_ratio_p10 > s.peg_ratio {
        return Err(Error::SanityBoundFailed);
    }
    if s.liquidity_2pct < 0 || s.liquidity_2pct > MAX_LIQUIDITY_OR_SUPPLY {
        return Err(Error::SanityBoundFailed);
    }
    if s.supply < 0 || s.supply > MAX_LIQUIDITY_OR_SUPPLY {
        return Err(Error::SanityBoundFailed);
    }
    Ok(())
}

/// `supply_change_bps` must match `supply` vs. the previous epoch's ring
/// slot (if any) within `SUPPLY_CHANGE_TOLERANCE_BPS`. Epoch 0 and an
/// asset with no previous slot both pass unconditionally: there is no
/// supply history yet to be inconsistent with.
fn check_supply_change_consistency(env: &Env, asset: &Address, s: &SignalSet) -> Result<(), Error> {
    if s.epoch == 0 {
        return Ok(());
    }
    let Some(previous) = storage::get_slot(env, asset, s.epoch - 1) else {
        return Ok(());
    };
    if previous.supply == 0 {
        // A zero previous supply makes "percent change" undefined; Section
        // 11.3 does not say what happens here, so this skips the
        // consistency check rather than dividing by zero or guessing a
        // convention the spec does not state.
        return Ok(());
    }

    let expected_bps = ((s.supply - previous.supply) * 10_000) / previous.supply;
    let diff = (expected_bps - s.supply_change_bps as i128).abs();
    if diff > SUPPLY_CHANGE_TOLERANCE_BPS {
        return Err(Error::SanityBoundFailed);
    }
    Ok(())
}

/// technical-doc.md Section 5.3 step 3, 11.3: cross checks every
/// configured `PriceAdapter` and rejects a posting whose `peg_ratio`
/// deviates more than `AMM_TOLERANCE_BPS` from an adapter's price, unless
/// that adapter's liquidity is below the asset's `min_liquidity` or its
/// timestamp is stale.
fn check_amm_cross_check(env: &Env, cfg: &AssetConfig, s: &SignalSet) -> Result<(), Error> {
    for adapter_address in cfg.amm_adapters.iter() {
        let (price, liquidity, timestamp) =
            PriceAdapterClient::new(env, &adapter_address).spot_price(&cfg.asset);
        if liquidity < cfg.min_liquidity {
            continue;
        }
        if is_stale_timestamp(env, timestamp) {
            continue;
        }
        let deviation_bps = ((s.peg_ratio - price).abs() * 10_000) / price.max(1);
        if deviation_bps > AMM_TOLERANCE_BPS {
            return Err(Error::AmmCrossCheckFailed);
        }
    }
    Ok(())
}

/// Review item C6 (re-review): finality is per epoch and INDEPENDENT.
/// A permanently missing epoch, an overturned epoch that is never
/// reposted, or an unresolved dispute must never block any OTHER
/// epoch's finality or the score from advancing past it. The previous
/// design (a sequential cursor walking forward one epoch at a time,
/// stopping dead at the first non-Final epoch) violated this; see
/// `finality_keeps_advancing_past_a_permanently_missing_epoch` and its
/// two siblings in `test.rs`, written to fail against that design
/// before this fix.
///
/// `newest_final` is now found by scanning BACKWARD from the newest
/// posted epoch, stopping at the first epoch (in that backward order)
/// found effectively Final, bounded by `max_lookback` epochs (at most
/// `RING_SLOTS`, since nothing older could still be physically
/// present in the ring). A missing, Empty, Disputed, or still-pending
/// epoch anywhere in that scanned range is simply skipped, never a
/// reason to give up early. The storage-layer scan itself
/// (`storage::advance_finality`) does the heavy lifting; this wrapper
/// just supplies `now` and the posting/lookback bounds, and turns the
/// storage layer's list of newly-announced epochs into actual
/// `signals_final` events (announcing is storage's job; the EVENT
/// belongs at this layer, next to every other event this contract
/// emits).
///
/// Every call site in this contract passes `FINALITY_LOOKBACK_EPOCHS`
/// (the full backfill window): the re-review's instruction is that
/// EVERY state changing call sweeps the whole window, not that some
/// callers get a smaller budget than others the way the old
/// `max_steps` design did. `max_lookback` stays a parameter (rather
/// than hardcoding the constant inside this function) so a future
/// caller with a genuine reason to scan less can still do so
/// explicitly, and so this function's own tests can probe a specific
/// bound without depending on the module-level constant.
///
/// Returns the newest epoch now known Final, if any.
fn try_advance_finality(env: &Env, asset: &Address, max_lookback: u32) -> Option<u64> {
    let now = env.ledger().timestamp();
    let Some(newest_posted) = storage::get_newest_epoch_pub(env, asset) else {
        return storage::get_newest_final(env, asset);
    };
    let (newest_final, newly_announced) =
        storage::advance_finality(env, asset, now, newest_posted, max_lookback);

    for epoch in newly_announced.iter() {
        events::SignalsFinal {
            asset: asset.clone(),
            epoch,
        }
        .publish(env);
    }

    // Never move the cached pointer backward: the fresh scan's own
    // bound only looks back `max_lookback` epochs from the newest
    // POSTED epoch, which is strictly a caller-side budget, not a
    // claim that nothing Final exists further back than that. A
    // smaller `max_lookback` (e.g. dispute_signals's bounded call)
    // must never erase a larger result an earlier, wider scan already
    // found and cached.
    let previous = storage::get_newest_final(env, asset);
    let advanced = match (newest_final, previous) {
        (Some(fresh), Some(cached)) => Some(fresh.max(cached)),
        (Some(fresh), None) => Some(fresh),
        (None, cached) => cached,
    };
    if let Some(advanced) = advanced {
        if Some(advanced) != previous {
            storage::set_newest_final(env, asset, advanced);
        }
    }
    advanced
}

/// Review item C1: the one place a `RiskScore` is actually computed and
/// written. Called from `post_signals` (after writing the new slot and
/// advancing finality), `finalize_endpoint`, and the dispute resolution
/// path, each time finality may have moved forward; a no-op (no write,
/// no `score_updated`/`band_changed` event) if the newest final epoch
/// has not moved past what is already stored, so repeated calls
/// within the same epoch do not spam those events. Every caller also
/// runs `check_stale_internal` afterward (re-review item C7), which is
/// where `asset_stale` actually gets decided, independent of whether
/// this function wrote anything.
///
/// The hysteresis down streak in `apply_hysteresis` only advances when
/// called here with a strictly newer final epoch than what is stored:
/// this is what review item C1's "the hysteresis down streak may advance
/// at most once per new epoch... only when the scored epoch is newer
/// than the stored score's epoch" requires, satisfied by construction
/// rather than by an extra check, because `score()` itself never calls
/// this function.
///
/// Review decision D1's "at least Distress while an event is in
/// progress" override is deliberately NOT applied here: it is a
/// read-time floor applied in `score()` instead (see that function's
/// doc comment), so that the `RiskScore` persisted here — and the
/// hysteresis streak computed from it — always reflects the plain
/// signal-derived band, never confusing a flag flip with a new epoch of
/// evidence.
fn recompute_score(env: &Env, asset: &Address, newest_final: u64) -> Result<(), Error> {
    let stored = storage::get_score(env, asset);
    if let Some(current) = &stored {
        if newest_final <= current.epoch {
            return Ok(()); // Nothing newer to score from.
        }
        if current.band == Band::Event {
            return Ok(()); // Sticky; only clear_event_band moves out of it.
        }
    }
    if is_stale_epoch(env, newest_final) {
        // The epoch that just became final is itself already outside
        // stale_after_epochs (a very late backfill); recording it would
        // immediately read back as stale, which score() already reports
        // correctly from the stored epoch without a write. Re-review
        // item C7: asset_stale emission is no longer this function's
        // job at all; every caller runs check_stale_internal
        // afterward, which detects exactly this "stale on arrival"
        // case from the stored score's own (unchanged) epoch and
        // announces the transition from there.
        return Ok(());
    }
    if newest_final + 1 < AGGREGATE_SLOTS_7D as u64 {
        // Not enough history yet for the 7 day baseline every component
        // needs (Section 6.5); review decision D2: a new asset with
        // fewer than 168 epochs reads as stale, by design, documented
        // here and in the PR report.
        return Ok(());
    }

    let cfg = storage::get_asset_config(env, asset).ok_or(Error::UnknownAsset)?;
    let formula = storage::get_formula(env).ok_or(Error::NotInitialized)?;
    let l_target = l_target_for(&cfg);
    let aggregates = score::aggregate_from_ring(env, asset, newest_final)?;
    let score::ScoreResult {
        score: raw,
        forced_warning,
    } = score::combined_score(&formula, &aggregates, l_target)?;
    let mut raw_band = score::band_for_score(raw);
    if forced_warning && raw_band < Band::Warning {
        // Section 6.3: "Forced to at least Warning if P = 100 or E =
        // 100", checked on the pre-weighting components in
        // combined_score; applied here, before hysteresis, so a
        // forced-up move is subject to the same "upward moves apply
        // immediately" rule (Section 6.4) as any other band increase.
        raw_band = Band::Warning;
    }

    let down_streak = storage::get_down_streak(env, asset);
    let (band, new_streak) = match &stored {
        Some(current) => score::apply_hysteresis(current, raw_band, down_streak, BAND_DOWN_EPOCHS),
        None => (raw_band, 0),
    };
    storage::set_down_streak(env, asset, new_streak);

    let result = RiskScore {
        epoch: newest_final,
        score: raw,
        band,
        formula_version: formula.version,
        stale: false,
    };
    storage::set_score(env, asset, &result);

    events::ScoreUpdated {
        asset: asset.clone(),
        epoch: newest_final,
        score: raw,
        formula_version: formula.version,
    }
    .publish(env);
    if stored.as_ref().map(|s| s.band) != Some(band) {
        events::BandChanged {
            asset: asset.clone(),
            from: stored.map(|s| s.band).unwrap_or(Band::Normal),
            to: band,
            epoch: newest_final,
        }
        .publish(env);
    }
    Ok(())
}

#[cfg(test)]
mod budget_test;
#[cfg(test)]
mod mocks;
#[cfg(test)]
mod test;
