use soroban_sdk::{contracttype, Address, Symbol, Vec};

/// Identifies one bond held in escrow by Staking (ADR-004). RiskOracle and
/// EventRegistry keep the dispute and event records; Staking holds the USDC.
/// technical-doc.md Section 4.5.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BondKey {
    /// (asset, epoch): a signal dispute bond, locked by RiskOracle.
    SignalDispute(Address, u64),
    /// (event_id): a Tier 2 proposer bond, locked by EventRegistry.
    EventProposal(u64),
    /// (event_id): a challenger bond, locked by EventRegistry.
    EventChallenge(u64),
}

/// A keeper's record in `Staking`. technical-doc.md Section 7.7, 12.3,
/// 15.1. Referenced by `Staking::keeper` (Section 12.3) but not
/// previously defined anywhere in this crate; added while building
/// `Staking` (feat/staking).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeeperInfo {
    pub bond: i128,
    /// Ledger timestamps of faults (lost signal disputes) still inside
    /// the trailing 30 day window; pruned on read, not on a timer.
    pub fault_times: Vec<u64>,
    pub suspended: bool,
    /// Set by the keeper's own, voluntary `unstake_request` while
    /// still registered and active; `None` otherwise. Distinct from
    /// `removed_at`: a governor `remove_keeper` uses its own exit
    /// delay instead of this cooldown (lead decision, feat/staking).
    pub unstake_requested_at: Option<u64>,
    /// Set by `remove_keeper` (governor). The keeper is immediately
    /// deactivated (no new posts; `is_active_keeper` reads `false`)
    /// but its bond is not released until `withdraw_keeper_bond` sees
    /// both `now >= removed_at + KEEPER_EXIT_DELAY_SECS` and
    /// `open_dispute_count == 0` (lead decision, feat/staking: removal
    /// is not an escape hatch from an open dispute).
    pub removed_at: Option<u64>,
    /// How many currently locked `BondKey::SignalDispute` bonds name
    /// this keeper as `subject` (lead decision, feat/staking).
    /// Incremented by `lock_bond`, decremented exactly once per bond
    /// by whichever of `release_bond`/`forfeit_bond` first settles it.
    /// Never allowed to underflow; asserted in tests.
    pub open_dispute_count: u32,
}

/// A reporter's record in `Staking`. technical-doc.md Section 7.7, 12.3,
/// 15.1. Referenced by `Staking::reporter` (Section 12.3) but not
/// previously defined anywhere in this crate; added while building
/// `Staking` (feat/staking).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReporterInfo {
    pub stake: i128,
    /// Fixed at `add_reporter`; immutable afterward (Section 7.3's
    /// "the reporter's registered region is used", not the report's
    /// own `region` field).
    pub region: Symbol,
    /// Ledger timestamps of faults still inside the trailing 30 day
    /// window; pruned on read, not on a timer.
    pub fault_times: Vec<u64>,
    pub suspended: bool,
    /// Set by the reporter's own, voluntary `unstake_request`; `None`
    /// otherwise. See `KeeperInfo::unstake_requested_at`.
    pub unstake_requested_at: Option<u64>,
    /// Set by `remove_reporter` (governor): deactivated immediately
    /// (no new probes), stake released only after
    /// `REPORTER_EXIT_DELAY_SECS` (lead decision, feat/staking), so
    /// every epoch the reporter could have probed can still settle,
    /// fault and slash it if warranted before its stake leaves.
    pub removed_at: Option<u64>,
}
