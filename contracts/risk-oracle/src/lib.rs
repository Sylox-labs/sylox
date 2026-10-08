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

/// technical-doc.md Section 23 `stale_after_epochs` default.
const STALE_AFTER_EPOCHS: u64 = 3;

/// technical-doc.md Section 23 `band_down_epochs` default.
const BAND_DOWN_EPOCHS: u32 = 3;

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
    /// registered (`update_asset` is for changing one).
    pub fn add_asset(env: Env, cfg: AssetConfig) -> Result<(), Error> {
        let config = Self::require_config(&env)?;
        config.governor.require_auth();
        if storage::get_asset_config(&env, &cfg.asset).is_some() {
            return Err(Error::AlreadyInitialized);
        }
        storage::set_asset_config(&env, &cfg.asset, &cfg);
        storage::add_to_asset_list(&env, &cfg.asset);
        Ok(())
    }

    /// technical-doc.md Section 12.1: "rejects a change to cfg.reference".
    pub fn update_asset(env: Env, asset: Address, cfg: AssetConfig) -> Result<(), Error> {
        let config = Self::require_config(&env)?;
        config.governor.require_auth();
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
            // No dispute state machine wiring here yet beyond
            // dispute_signals/resolve_signal_dispute below reopening a
            // slot to Empty on an overturn; any OTHER existing posting
            // for this epoch (Pending, Disputed or Final) blocks a
            // repost, matching Section 11.3. An overturned epoch's
            // Signals entry is intentionally left in place as history
            // (Section 15.2); only its ring slot returns to Empty, so
            // `get_signals` would still find it here. This means a
            // reposted epoch after an overturn currently fails with
            // EpochAlreadyPosted — a known gap, see the PR description.
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

        let bond = signal_dispute_bond();
        StakingClient::new(&env, &config.staking).lock_bond(
            &sylox_types::BondKey::SignalDispute(asset.clone(), epoch),
            &disputer,
            &bond,
        );
        storage::set_dispute(&env, &asset, epoch, &DisputeRecord { disputer, alt_hash });
        storage::set_slot_state(&env, &asset, epoch, sylox_types::SlotState::Disputed);
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
        let _ = reason; // stored only by EventRegistry-style callers in Phase 3; RiskOracle has nowhere to persist it yet (known gap).

        let dispute =
            storage::get_dispute(&env, &asset, epoch).ok_or(Error::DisputeWindowClosed)?;
        let signals = storage::get_signals(&env, &asset, epoch).ok_or(Error::WrongEpoch)?;
        let staking = StakingClient::new(&env, &config.staking);
        let bond_key = sylox_types::BondKey::SignalDispute(asset.clone(), epoch);

        if keeper_wins {
            staking.forfeit_bond(&bond_key, &Some(signals.poster.clone()));
            storage::set_slot_state(&env, &asset, epoch, sylox_types::SlotState::Final);
        } else {
            staking.release_bond(&bond_key);
            staking.slash(
                &signals.poster,
                &keeper_slash(),
                &Some(dispute.disputer.clone()),
                &BytesN::from_array(&env, &[0u8; 32]),
            );
            storage::set_slot_state(&env, &asset, epoch, sylox_types::SlotState::Empty);
        }
        storage::clear_dispute(&env, &asset, epoch);
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
            }
        }
        staking.settle_probes(&asset, &epoch);
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

    /// technical-doc.md Section 12.1, 6. Computes and persists a fresh
    /// `RiskScore` from the latest Final epoch's ring window, applying
    /// hysteresis against the previously stored score. Returns the stored
    /// score unchanged (and does not write) if the asset is stale or has
    /// no Final epoch yet, or if the band is currently the sticky `Event`
    /// band (only `clear_event_band` moves out of it).
    pub fn score(env: Env, asset: Address) -> Result<RiskScore, Error> {
        let cfg = storage::get_asset_config(&env, &asset).ok_or(Error::UnknownAsset)?;
        let stored = storage::get_score(&env, &asset);

        let Some(newest) = storage::get_newest_epoch_pub(&env, &asset) else {
            return Ok(stale_score(&stored));
        };
        if Self::is_stale_at(&env, newest) {
            return Ok(stale_score(&stored));
        }
        if newest + 1 < AGGREGATE_SLOTS_7D as u64 {
            // Not enough history yet for the 7 day baseline every
            // component needs (Section 6.5): report advisory-stale rather
            // than scoring on a partial window. A brand new asset is
            // "stale" in the sense that nothing trustworthy can be
            // computed yet, even though it is actively posting.
            return Ok(stale_score(&stored));
        }
        if let Some(current) = &stored {
            if current.band == Band::Event {
                return Ok(*current);
            }
        }

        let formula = storage::get_formula(&env).ok_or(Error::NotInitialized)?;
        let l_target = l_target_for(&cfg);
        let aggregates = score::aggregate_from_ring(&env, &asset, newest)?;
        let raw = score::combined_score(&formula, &aggregates, l_target)?;
        let raw_band = score::band_for_score(raw);

        let down_streak = storage::get_down_streak(&env, &asset);
        let (band, new_streak) = match &stored {
            Some(current) => {
                score::apply_hysteresis(current, raw_band, down_streak, BAND_DOWN_EPOCHS)
            }
            None => (raw_band, 0),
        };
        storage::set_down_streak(&env, &asset, new_streak);

        let result = RiskScore {
            epoch: newest,
            score: raw,
            band,
            formula_version: formula.version,
            stale: false,
        };
        storage::set_score(&env, &asset, &result);
        Ok(result)
    }

    pub fn band(env: Env, asset: Address) -> Result<Band, Error> {
        Ok(Self::score(env, asset)?.band)
    }

    pub fn is_stale(env: Env, asset: Address) -> bool {
        match storage::get_newest_epoch_pub(&env, &asset) {
            Some(newest) => Self::is_stale_at(&env, newest),
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

    fn is_stale_at(env: &Env, newest_epoch: u64) -> bool {
        let now = env.ledger().timestamp();
        let current_epoch = now / EPOCH_SECS;
        current_epoch.saturating_sub(newest_epoch) > STALE_AFTER_EPOCHS
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

#[cfg(test)]
mod budget_test;
#[cfg(test)]
mod mocks;
#[cfg(test)]
mod test;
