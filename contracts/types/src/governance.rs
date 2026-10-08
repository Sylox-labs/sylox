use soroban_sdk::{contracttype, Address, BytesN, Map, Symbol, Vec};

use crate::{AssetConfig, EventDefinition, SeriesTerms, TreasuryBucket};

/// Governor action payloads. technical-doc.md Section 17.1.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Action {
    SetParam(Symbol, i128),
    AddAsset(AssetConfig),
    UpdateAsset(Address, AssetConfig),
    DisableAsset(Address),
    /// Registers the next canonical version for the definition's
    /// `(asset, kind)` (ADR-001).
    RegisterDefinition(EventDefinition),
    OpenSeries(SeriesTerms),
    /// Keeper membership lives in Staking (ADR-004).
    AddKeeper(Address),
    RemoveKeeper(Address),
    /// Reporter membership lives in Staking (ADR-004).
    AddReporter(Address, Symbol),
    RemoveReporter(Address),
    SetCommittee(Address),
    SetFormula(u32, Vec<u32>, Map<Symbol, i128>),
    SetSeriesWasm(BytesN<32>),
    /// (contract, new wasm hash).
    Upgrade(Address, BytesN<32>),
    Unpause(PauseScope),
    SetSigners(Vec<Address>, u32),
    /// (from bucket, to bucket, amount): moves Treasury funds between
    /// buckets, for example fees into a reward pool (ADR-004).
    TreasuryAllocate(TreasuryBucket, TreasuryBucket, i128),
    /// (bucket, recipient, amount): pays Treasury funds out (ADR-004).
    TreasurySpend(TreasuryBucket, Address, i128),
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PauseScope {
    NewCover,
    NewSeries,
    Deposits,
    Signals,
}

/// Lifecycle of a queued action. technical-doc.md Section 17.2.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActionState {
    /// Queued, approvals below threshold.
    Queued,
    /// Threshold met, waiting for `eta`.
    Approved,
    Executed,
    Cancelled,
    /// `expires_at` passed without execution. Reported lazily by reads.
    Expired,
}

/// technical-doc.md Section 17.1.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QueuedAction {
    pub id: u64,
    pub action: Action,
    pub proposer: Address,
    pub approvals: Vec<Address>,
    /// Earliest execution time: queue time plus the action's timelock.
    pub eta: u64,
    /// `eta + grace_secs`; after this the action can never execute.
    pub expires_at: u64,
    pub state: ActionState,
}
