use soroban_sdk::{contracttype, Address, BytesN};

/// Fixed terms for one protection series. technical-doc.md Section 4.4.
/// Immutable once a series is opened (invariant I11).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SeriesTerms {
    pub asset: Address,
    pub event_def_hash: BytesN<32>,
    /// USDC SAC.
    pub settlement: Address,
    pub start: u64,
    /// start + 30 or 90 days.
    pub expiry: u64,
    /// e.g. 30 days.
    pub claim_window_secs: u64,
    /// Max total cover.
    pub cap: i128,
    pub max_cover_per_buyer: i128,
    /// Insurable interest check.
    pub require_holding: bool,
    /// Protocol fee on premiums.
    pub fee_bps: u32,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SeriesState {
    Open,
    Closed,
    Triggered,
    Pending,
    Expired,
    Finalized,
}

/// A seller's single standing quote. technical-doc.md Section 4.4.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Quote {
    pub seller: Address,
    /// Annualised premium rate.
    pub rate_bps: u32,
    /// Cover this seller still offers.
    pub available: i128,
}

/// A seller's position in one series. technical-doc.md Section 9.1.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SellerPosition {
    pub collateral: i128,
    pub cover_written: i128,
    pub premium_earned: i128,
}

/// Running totals for a series, checked against invariant I3.
/// technical-doc.md Section 10.3.
#[contracttype]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct SeriesTotals {
    pub total_collateral: i128,
    pub total_premium: i128,
    pub total_paid: i128,
    pub total_withdrawn: i128,
}
