use soroban_sdk::contracttype;

/// The latest computed risk score for an asset. technical-doc.md Section 4.2.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RiskScore {
    pub epoch: u64,
    /// 0..=100.
    pub score: u32,
    pub band: Band,
    pub formula_version: u32,
    pub stale: bool,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum Band {
    Normal,
    Watch,
    Warning,
    Distress,
    /// Set when a credit event is Declared; sticky until governance
    /// re-enables the asset.
    Event,
}
