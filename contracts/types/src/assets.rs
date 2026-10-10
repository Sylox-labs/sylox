use soroban_sdk::{contracttype, Address, BytesN, String, Symbol, Vec};

/// Configuration for one issued asset covered by the RiskOracle.
/// technical-doc.md Section 4.1.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetConfig {
    /// Stellar Asset Contract address of the issued asset.
    pub asset: Address,
    /// Classic issuer account (G...).
    pub issuer: Address,
    /// What the asset should be worth. Fixed at `add_asset`: `update_asset`
    /// rejects any change, so every event definition that pins it stays
    /// valid (ADR-006).
    pub reference: Reference,
    /// For SEP-1 / SEP-24 probing.
    pub home_domain: String,
    /// Optional Soroban AMM price adapters (`PriceAdapter`, Section 3.3).
    pub amm_adapters: Vec<Address>,
    /// FX adapter (`FxAdapter`, Section 3.3). Required when `reference` is
    /// `Fiat`, `None` otherwise.
    pub fx_adapter: Option<Address>,
    /// In USDC units. A Depeg window counts only if the median
    /// `liquidity_2pct` of the 7 days before the window started is at least
    /// this value. Never compared against live liquidity (ADR-005).
    pub min_liquidity: i128,
    /// Issuer account flags. IssuerFreeze definitions can only be registered
    /// when these make a freeze possible (ADR-006).
    pub issuer_flags: IssuerFlags,
    pub enabled: bool,
}

/// The classic issuer flags that make an issuer freeze possible. An
/// IssuerFreeze definition can be registered only if at least one is set.
/// technical-doc.md Section 4.1, ADR-006.
#[contracttype]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct IssuerFlags {
    /// AUTH_REVOCABLE: the issuer can revoke a holder's authorization.
    pub auth_revocable: bool,
    /// CLAWBACK_ENABLED: the issuer can claw back balances.
    pub clawback_enabled: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Reference {
    /// 1 unit = 1 USD.
    Usd,
    /// ISO 4217 code and the FX rate basis it is priced against, via the
    /// FX adapter (ADR-006).
    Fiat(Symbol, FxRateSource),
    /// Pegged to another onchain asset.
    Asset(Address),
}

/// Which FX rate a `Reference::Fiat` is priced against. Matters wherever an
/// official rate and a market (parallel) rate diverge, for example ARS.
/// technical-doc.md Section 4.1, ADR-006.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FxRateSource {
    /// The rate published by the central bank or official fixing.
    Official,
    /// The rate at which the currency actually trades.
    Market,
}

/// Per asset sub-epoch configuration. technical-doc.md Section 15.1
/// `SubEpochConfig(asset)`, Section 5.9 S1. `sub_epoch_secs` is the
/// value currently in effect; `pending_sub_epoch_secs` and
/// `effective_from_hour` describe a queued change that has not yet
/// taken effect (both `None` when no change is pending). A change
/// never applies before `effective_from_hour`, so no sub-epoch
/// already posted, or postable before that boundary, is ever
/// reinterpreted under a different length.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SubEpochConfig {
    pub sub_epoch_secs: u64,
    pub pending_sub_epoch_secs: Option<u64>,
    pub effective_from_hour: Option<u64>,
}

/// Identifies one sub-epoch at the posting/dispute API boundary:
/// `hour`, and `sub`, its position within that hour under whichever
/// `sub_epoch_secs` governed it. technical-doc.md Section 5.9 S2.
/// `Sub(asset)`'s own ring stores a different identity internally
/// (`sub_start`, the sub-epoch's absolute start time, Section 5.9 S3),
/// since what `sub` means depends on an interval that can later
/// change; `SubEpoch` is the human-meaningful pair a keeper posts
/// against, converted internally to `sub_start`.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SubEpoch {
    pub hour: u64,
    pub sub: u32,
}

/// One epoch's measured signals for one asset. technical-doc.md Section 4.1.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignalSet {
    pub epoch: u64,
    /// Ledger timestamp.
    pub posted_at: u64,
    /// TWAP price / reference, SCALE 1e7.
    pub peg_ratio: i128,
    /// 10th percentile of the volume weighted price series in the window,
    /// divided by the reference, SCALE 1e7. A single wick cannot move it
    /// (ADR-005).
    pub peg_ratio_p10: i128,
    /// Depth within 2% of peg, USDC units.
    pub liquidity_2pct: i128,
    /// Net burned minus issued this epoch, asset units.
    pub redemption_net: i128,
    /// Total circulating supply, asset units. Keeper posted from ledger asset
    /// stats; SEP-41 has no `total_supply`, so it cannot be cross checked
    /// onchain (ADR-005).
    pub supply: i128,
    /// vs previous epoch.
    pub supply_change_bps: i32,
    pub issuer_actions: IssuerActions,
    /// Sourced only from `Staking::aggregate`. RiskOracle overwrites this
    /// field on `post_signals` and `finalize_endpoint`; any keeper supplied
    /// value is ignored, so keepers post `Unknown` (ADR-005).
    pub endpoint: EndpointStatus,
    /// Hash of raw inputs, for recomputation.
    pub inputs_hash: BytesN<32>,
    pub poster: Address,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct IssuerActions {
    pub clawbacks: u32,
    pub clawback_amount: i128,
    pub auth_revocations: u32,
    pub flag_changes: u32,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EndpointStatus {
    Unknown,
    Up,
    Degraded,
    Down,
}

/// Finality of one ring buffer slot. technical-doc.md Section 5.8.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SlotState {
    /// Never posted, or overturned and not yet reposted. Counts as missing.
    Empty,
    /// Posted, inside its dispute window. Reads as Final once
    /// `pending_until` has passed.
    Pending,
    /// Posted and disputed. Not final until the dispute resolves; an
    /// overturned slot returns to Empty for reposting (ADR-005).
    Disputed,
    Final,
}

/// One epoch slot of the per asset ring buffer that Tier 1 checks, the
/// cover gate and the 24 hour and 7 day aggregates read in a single entry,
/// instead of separate `Signals(asset, epoch)` entries.
/// technical-doc.md Section 5.8, ADR-005.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RingSlot {
    pub epoch: u64,
    pub state: SlotState,
    /// Ledger timestamp after which a `Pending` slot reads as Final.
    pub pending_until: u64,
    pub peg_ratio: i128,
    pub liquidity_2pct: i128,
    pub redemption_net: i128,
    pub supply: i128,
    pub supply_change_bps: i32,
    pub clawback_amount: i128,
    pub auth_revocations: u32,
    pub endpoint: EndpointStatus,
}

/// A reporter's signed observation of one asset's endpoint for one epoch.
/// technical-doc.md Section 7.3.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProbeReport {
    pub asset: Address,
    pub epoch: u64,
    pub status: EndpointStatus,
    /// e.g. "eu", "us", "af".
    pub region: Symbol,
    /// Raw HTTP transcripts bundle.
    pub evidence_hash: BytesN<32>,
}
