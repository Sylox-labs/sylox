use soroban_sdk::{contracttype, Address, BytesN, Vec};

/// The exact rules for what counts as a credit event, stored by hash.
/// technical-doc.md Section 4.3.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventDefinition {
    /// Which failures trigger.
    pub kinds: Vec<EventKind>,
    /// e.g. 9_500_000 = 0.95.
    pub depeg_threshold: i128,
    /// e.g. 259_200 = 72h.
    pub depeg_window_secs: u64,
    /// X in the PRD.
    pub freeze_pct_bps: u32,
    /// Y in the PRD.
    pub mint_spike_bps: u32,
    pub halt_window_secs: u64,
    /// e.g. 86_400.
    pub challenge_secs: u64,
    /// e.g. 9_800_000, only during challenge.
    pub cure_threshold: i128,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EventKind {
    Depeg,
    IssuerFreeze,
    MintWithoutBacking,
    WithdrawalHalt,
    Insolvency,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EventState {
    None,
    Proposed,
    Challenged,
    Escalated,
    Declared,
    Rejected,
    Cured,
}

/// technical-doc.md Section 4.3.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventRecord {
    pub id: u64,
    pub asset: Address,
    pub kind: EventKind,
    /// 1, 2 or 3.
    pub tier: u32,
    pub state: EventState,
    pub proposed_at: u64,
    pub declared_at: Option<u64>,
    pub evidence_hash: BytesN<32>,
    pub proposer: Address,
    pub bond: i128,
}

/// Returned by `EventRegistry::event_status`. technical-doc.md Section 12.2.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AssetEventStatus {
    None,
    InProgress(u64),
    Declared(u64, EventKind, u64, u64),
}
