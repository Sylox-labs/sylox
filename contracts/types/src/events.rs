use soroban_sdk::{contracttype, Address, BytesN};

use crate::Reference;

/// The canonical, versioned rules for one event kind on one asset.
/// Stored by `(asset, kind, version)`; exactly one version per
/// `(asset, kind)` is canonical at a time (ADR-001).
/// technical-doc.md Section 4.3.
///
/// Parameters that do not apply to `kind` must be zero; `register_definition`
/// rejects a definition that sets them.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventDefinition {
    pub asset: Address,
    pub kind: EventKind,
    /// def_version. Assigned by `register_definition` as the previous
    /// canonical version plus one, starting at 1.
    pub version: u32,
    /// Copy of `AssetConfig.reference` at registration, including the FX
    /// rate source, so the definition fixes what "the peg" means (ADR-006).
    pub reference: Reference,
    /// Depeg: e.g. 9_500_000 = 0.95.
    pub depeg_threshold: i128,
    /// Depeg: e.g. 259_200 = 72h.
    pub depeg_window_secs: u64,
    /// Depeg: epochs in the window with no Final posting that are ignored,
    /// e.g. 6 of 72. More than this and the check fails (ADR-005).
    pub max_missing_epochs: u32,
    /// Depeg: e.g. 9_800_000, only during challenge.
    pub cure_threshold: i128,
    /// IssuerFreeze: X in the PRD. Compared against `clawback_amount /
    /// supply` over the 7 day window (Section 8.2).
    pub freeze_pct_bps: u32,
    /// IssuerFreeze: new (feat/event-registry). Section 8.2's own text
    /// ("`auth_revocations` above the threshold") names this check but
    /// the spec, before this field, defined no threshold for it;
    /// `freeze_pct_bps` is a basis-points ratio against `supply`,
    /// which has no sensible meaning against a raw revocation count.
    /// The count of authorization revocations in the 7 day window must
    /// exceed this value for the revocation branch of the IssuerFreeze
    /// check to pass.
    pub auth_revocation_threshold: u32,
    /// MintWithoutBacking: Y in the PRD.
    pub mint_spike_bps: u32,
    /// WithdrawalHalt: e.g. 259_200 = 72h.
    pub halt_window_secs: u64,
    /// All kinds: e.g. 86_400.
    pub challenge_secs: u64,
    /// All kinds: committee ruling deadline counted from escalation,
    /// e.g. 1_209_600 = 14 days (ADR-002).
    pub ruling_deadline_secs: u64,
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

/// One proposed credit event, keyed by `(asset, kind, def_version)`
/// (ADR-001). technical-doc.md Section 4.3.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventRecord {
    pub id: u64,
    pub asset: Address,
    pub kind: EventKind,
    /// The canonical definition version the proposal was checked against.
    pub def_version: u32,
    /// 1, 2 or 3.
    pub tier: u32,
    pub state: EventState,
    /// Start of the failure window. Decides which series the event covers
    /// (ADR-003, Section 8.6).
    pub window_start: u64,
    pub proposed_at: u64,
    /// Set when a challenge escalates the event to the committee. The ruling
    /// deadline is `escalated_at + ruling_deadline_secs` (ADR-002).
    pub escalated_at: Option<u64>,
    pub declared_at: Option<u64>,
    pub evidence_hash: BytesN<32>,
    pub proposer: Address,
    /// Proposer bond, held by Staking (ADR-004). Zero for Tier 1 and Tier 3.
    pub bond: i128,
}

/// Returned by `EventRegistry::event_status(asset, kind)`, which is per
/// `(asset, kind)` for the canonical version (ADR-001).
/// technical-doc.md Section 12.2.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AssetEventStatus {
    None,
    /// (event_id).
    InProgress(u64),
    /// (event_id, def_version, window_start, declared_at).
    Declared(u64, u32, u64, u64),
}

/// Result of `EventRegistry::cover_gate(asset)`: whether new cover may be
/// bought on an asset right now (ADR-003). technical-doc.md Section 9.4.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CoverGate {
    /// No trailing failure signal and no event in progress.
    Clear,
    /// An event for the asset, of any kind, is Proposed, Challenged or
    /// Escalated.
    EventInProgress,
    /// An epoch in the trailing depeg window has `peg_ratio` below the
    /// depeg threshold.
    RecentDepeg,
    /// Endpoint status was Down or Degraded in the trailing halt window.
    RecentEndpointOutage,
    /// A clawback or authorization revocation occurred in the last 7 days.
    RecentIssuerAction,
    /// Since v1.5 (Section 5.9 S5): more unbuilt hours sit in the
    /// trailing depeg window than `cover_gate` can safely scan in one
    /// call (`MAX_UNBUILT_HOURS_SCANNED_BY_COVER_GATE`). Blocks new
    /// cover the same way any other gate state does, rather than
    /// skipping the depeg check outright or risking the call itself
    /// exceeding the network's own transaction memory limit: a long
    /// enough build backlog, or enough simultaneous disputes each
    /// holding their own hour open, reads the same as a depeg would,
    /// since the feed cannot currently prove it is clear.
    UnbuiltBacklog,
}
