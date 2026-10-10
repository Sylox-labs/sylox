//! Minimal client interfaces for the contracts `EventRegistry` calls
//! into, but does not implement. technical-doc.md Section 5.8, 12.1
//! (RiskOracle), 12.3 (Staking), 12.6 (Governor). Each trait lists only
//! the functions `EventRegistry` actually calls, not that contract's
//! full API; mock contracts implementing these traits live in `test.rs`
//! and `budget_test.rs`, never the production build.

use soroban_sdk::{contractclient, Address, Env, Vec};
use sylox_types::{AssetConfig, BondKey, RingSlot, SlotState};

#[contractclient(name = "RiskOracleClient")]
#[allow(dead_code)]
pub trait RiskOracle {
    fn ring(env: Env, asset: Address) -> Vec<RingSlot>;
    fn effective_window(
        env: Env,
        asset: Address,
        start_epoch: u64,
        count: u32,
    ) -> Vec<Option<SlotState>>;
    fn asset_config(env: Env, asset: Address) -> Option<AssetConfig>;
    fn set_event_band(env: Env, asset: Address);
    fn clear_event_band(env: Env, asset: Address);
    fn set_event_in_progress(env: Env, asset: Address, in_progress: bool);
    /// PR #15 review, finding F4: the real newest epoch ever posted,
    /// independent of whether that epoch's own ring position is
    /// currently `Empty` (overturned, not yet reposted).
    fn newest_epoch(env: Env, asset: Address) -> Option<u64>;
    /// PR #25 review: the first epoch ever posted for this asset,
    /// needed so the Tier 1 history baselines below measure history
    /// relative to when this asset actually started posting, not
    /// against the newest epoch's own (always large) absolute number.
    fn first_epoch(env: Env, asset: Address) -> Option<u64>;
    /// technical-doc.md Section 5.9 S5 (v1.5, footprint-fix revision):
    /// each requested hour's own sub-epochs' `peg_ratio` (in `sub`
    /// order, `None` for a sub-epoch not posted or currently Disputed),
    /// one entry per requested hour, in the same order. Only valid for
    /// an hour still INSIDE `Sub(asset)`'s own 5-hour span
    /// (`sylox_types::time::SUB_RING_SLOTS *
    /// SUB_EPOCH_GRID_SECS`); `depeg_check` itself decides which hours
    /// qualify before calling this, never this function. ONE
    /// cross-contract call touching exactly one ledger key
    /// (`Sub(asset)`) regardless of how many hours or sub-epochs are
    /// requested, never `HeldHour`: `HeldHour` is a write-path
    /// (build/dispute) concern only, never read by the gate, so this
    /// call's own footprint stays constant no matter how many hours
    /// are unbuilt (R10).
    fn sub_peg_ratios_in_span_batch(
        env: Env,
        asset: Address,
        hours: Vec<u64>,
    ) -> Vec<Vec<Option<i128>>>;
}

/// The slice of `Staking`'s API (Section 12.3) that `EventRegistry`
/// calls. Tier 1 posts no proposer bond (design note Section 7); only
/// the challenger's `EventChallenge(event_id)` bond is ever locked.
#[contractclient(name = "StakingClient")]
#[allow(dead_code)]
pub trait Staking {
    fn lock_bond(env: Env, key: BondKey, owner: Address, amount: i128, subject: Option<Address>);
    fn release_bond(env: Env, key: BondKey);
    fn forfeit_bond(env: Env, key: BondKey, winner: Option<Address>);
}

/// The slice of `Governor`'s API (Section 12.6) that `EventRegistry`
/// calls: resolving the current committee address for `rule`'s auth
/// check, the same pattern `RiskOracle.resolve_signal_dispute` already
/// uses for the signal-dispute side of this (ADR-010).
#[contractclient(name = "GovernorClient")]
#[allow(dead_code)]
pub trait Governor {
    fn committee(env: Env) -> Address;
}
