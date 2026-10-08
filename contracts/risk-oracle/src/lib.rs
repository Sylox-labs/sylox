#![no_std]

//! RiskOracle: stores per asset signals per epoch, computes the score,
//! exposes bands and staleness. technical-doc.md Section 5.
//!
//! Phase 1 scope only (see the risk-oracle PR description): AssetConfig
//! storage, the Section 5.8 ring buffer, and a post_signals that writes a
//! SignalSet into it. Everything else in Section 12.1 is Phase 2.

mod error;
mod storage;

use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Symbol, Vec};
use sylox_types::{AssetConfig, RingSlot, SignalSet, SCALE};

pub use error::Error;

/// Signal posting window: how far back a closed epoch may still be posted.
/// technical-doc.md Section 5.2, Section 23 `window_secs` default.
const WINDOW_SECS: u64 = 259_200;

/// Default epoch length. technical-doc.md Section 23 `epoch_secs`.
const EPOCH_SECS: u64 = 3_600;

/// Default signal dispute window. technical-doc.md Section 23
/// `signal_dispute_secs`.
const SIGNAL_DISPUTE_SECS: u64 = 7_200;

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
        Ok(())
    }

    /// technical-doc.md Section 12.1. Phase 1: stores the config as given;
    /// does not yet validate `fx_adapter` presence for `Fiat` references or
    /// check `amm_adapters` (Phase 2, Section 4.1 field notes).
    pub fn add_asset(env: Env, cfg: AssetConfig) -> Result<(), Error> {
        let config = Self::require_config(&env)?;
        config.governor.require_auth();
        storage::set_asset_config(&env, &cfg.asset, &cfg);
        Ok(())
    }

    /// technical-doc.md Section 12.1, Section 5.2, 5.3, 11.3.
    ///
    /// Phase 1 scope: performs the epoch and sanity bound checks and writes
    /// the signal set plus its ring slot. Does not yet check keeper
    /// eligibility against `Staking` (`KeeperNotActive`), cross check a
    /// `PriceAdapter`, or overwrite `endpoint` from `Staking.aggregate`;
    /// those need `Staking` and the adapter interfaces, which are out of
    /// scope for this contract per the PR brief. `s.endpoint` is always
    /// discarded and stored as `Unknown`, matching the final behaviour for
    /// an asset with no aggregate yet (Section 5.1, 5.3 step 2).
    pub fn post_signals(
        env: Env,
        keeper: Address,
        asset: Address,
        mut s: SignalSet,
    ) -> Result<(), Error> {
        keeper.require_auth();

        let cfg = storage::get_asset_config(&env, &asset).ok_or(Error::UnknownAsset)?;
        if !cfg.enabled {
            return Err(Error::UnknownAsset);
        }

        let now = env.ledger().timestamp();
        check_epoch_window(s.epoch, now)?;
        if storage::get_signals(&env, &asset, s.epoch).is_some() {
            // Phase 1 has no dispute state machine, so any existing
            // posting for this epoch is final; EpochAlreadyPosted always
            // applies. Phase 2 narrows this to Pending/Disputed/Final per
            // Section 11.3 and allows backfill of an Overturned epoch.
            return Err(Error::EpochAlreadyPosted);
        }
        check_sanity_bounds(&s)?;

        s.poster = keeper;
        s.posted_at = now;
        s.endpoint = sylox_types::EndpointStatus::Unknown;

        storage::set_signals(&env, &asset, s.epoch, &s);

        let pending_until = now + SIGNAL_DISPUTE_SECS;
        storage::write_ring_slot(&env, &asset, s.epoch, &s, pending_until);

        Ok(())
    }

    // -- reads --

    pub fn asset_config(env: Env, asset: Address) -> Option<AssetConfig> {
        storage::get_asset_config(&env, &asset)
    }

    pub fn signals(env: Env, asset: Address, epoch: u64) -> Option<SignalSet> {
        storage::get_signals(&env, &asset, epoch)
    }

    /// technical-doc.md Section 5.8, 12.1: one storage read, oldest slot
    /// first by position, not by recency (the ring wraps).
    pub fn ring(env: Env, asset: Address) -> Vec<RingSlot> {
        storage::get_ring(&env, &asset)
    }

    /// Phase 1 resource spike only, not part of the Section 12.1 API:
    /// loads the ring and computes the 24h and 7d aggregates (Section 6.5),
    /// the 168 slot median liquidity (Section 11.1) and the 72 slot window
    /// used by the Depeg check (Section 8.2), from the one `ring(asset)`
    /// read. Exists so the budget tests can measure a real, metered
    /// contract call doing this work, instead of approximating it in test
    /// code (which the Soroban budget does not meter). Returns enough of
    /// the result to prove the computation is not optimised away.
    #[cfg(test)]
    pub fn tier1_style_read(env: Env, asset: Address) -> (i128, i128, u32, i128, i128) {
        let ring = storage::get_ring(&env, &asset);
        let slots = storage::RING_SLOTS;

        let mut redemption_net_24h: i128 = 0;
        for i in (slots - 24)..slots {
            redemption_net_24h += ring.get(i).unwrap().redemption_net;
        }

        let mut clawback_amount_7d: i128 = 0;
        let mut auth_revocations_7d: u32 = 0;
        let mut liquidity_168: Vec<i128> = Vec::new(&env);
        for i in (slots - 168)..slots {
            let slot = ring.get(i).unwrap();
            clawback_amount_7d += slot.clawback_amount;
            auth_revocations_7d += slot.auth_revocations;
            liquidity_168.push_back(slot.liquidity_2pct);
        }
        let median_liquidity = median(&liquidity_168);

        let mut window_ratios: Vec<i128> = Vec::new(&env);
        for i in (slots - 72)..slots {
            window_ratios.push_back(ring.get(i).unwrap().peg_ratio);
        }
        let window_p10 = percentile_10(&window_ratios);

        (
            redemption_net_24h,
            clawback_amount_7d,
            auth_revocations_7d,
            median_liquidity,
            window_p10,
        )
    }

    fn require_config(env: &Env) -> Result<Config, Error> {
        env.storage()
            .instance()
            .get(&CONFIG_KEY)
            .ok_or(Error::NotInitialized)
    }
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
/// covers `[n * epoch_secs, (n + 1) * epoch_secs)` from the Unix epoch:
/// the spec names a `genesis` but never defines one (see the PR's "Spec
/// deviations" section), so this contract takes `genesis = 0`, making the
/// epoch number a pure function of ledger time with no extra stored state.
fn check_epoch_window(epoch: u64, now: u64) -> Result<(), Error> {
    let current_epoch = now / EPOCH_SECS;
    if epoch >= current_epoch {
        // Not yet closed.
        return Err(Error::WrongEpoch);
    }
    let epoch_close = (epoch + 1) * EPOCH_SECS;
    if now.saturating_sub(epoch_close) > WINDOW_SECS {
        // Closed before the current window_secs.
        return Err(Error::WrongEpoch);
    }
    Ok(())
}

/// technical-doc.md Section 11.3.
fn check_sanity_bounds(s: &SignalSet) -> Result<(), Error> {
    if s.peg_ratio < 0 || s.peg_ratio > 2 * SCALE {
        return Err(Error::SanityBoundFailed);
    }
    if s.peg_ratio_p10 < 0 || s.peg_ratio_p10 > 2 * SCALE {
        return Err(Error::SanityBoundFailed);
    }
    if s.liquidity_2pct < 0 {
        return Err(Error::SanityBoundFailed);
    }
    if s.supply < 0 {
        return Err(Error::SanityBoundFailed);
    }
    Ok(())
}

/// Insertion sort over a Soroban `Vec<i128>`. Used only by
/// `tier1_style_read` (Phase 1 spike), where `values` holds at most 168
/// elements, so an O(n^2) sort is cheap enough and the metered cost of a
/// real sort (over `Vec::sort` in a `std` build) is still what gets
/// reported.
#[cfg(test)]
fn sorted(values: &Vec<i128>) -> Vec<i128> {
    let mut out = values.clone();
    let len = out.len();
    for i in 1..len {
        let key = out.get(i).unwrap();
        let mut j = i;
        while j > 0 && out.get(j - 1).unwrap() > key {
            let prev = out.get(j - 1).unwrap();
            out.set(j, prev);
            j -= 1;
        }
        out.set(j, key);
    }
    out
}

#[cfg(test)]
fn median(values: &Vec<i128>) -> i128 {
    let sorted = sorted(values);
    sorted.get(sorted.len() / 2).unwrap()
}

#[cfg(test)]
fn percentile_10(values: &Vec<i128>) -> i128 {
    let sorted = sorted(values);
    sorted.get(sorted.len() / 10).unwrap()
}

#[cfg(test)]
mod budget_test;
#[cfg(test)]
mod test;
