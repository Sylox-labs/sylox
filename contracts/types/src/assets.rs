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
    /// What the asset should be worth.
    pub reference: Reference,
    /// For SEP-1 / SEP-24 probing.
    pub home_domain: String,
    /// Optional Soroban AMM price adapters.
    pub amm_adapters: Vec<Address>,
    /// In USDC units; below this depeg cannot trigger.
    pub min_liquidity: i128,
    pub enabled: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Reference {
    /// 1 unit = 1 USD.
    Usd,
    /// ISO 4217 code, priced via FX adapter.
    Fiat(Symbol),
    /// Pegged to another onchain asset.
    Asset(Address),
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
    /// Lowest window value, SCALE 1e7.
    pub peg_ratio_min: i128,
    /// Depth within 2% of peg, USDC units.
    pub liquidity_2pct: i128,
    /// Net burned minus issued this epoch, asset units.
    pub redemption_net: i128,
    /// Total circulating supply, asset units.
    pub supply: i128,
    /// vs previous epoch.
    pub supply_change_bps: i32,
    pub issuer_actions: IssuerActions,
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
