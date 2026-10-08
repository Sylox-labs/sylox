use soroban_sdk::{contracttype, Address, BytesN, Map, Symbol, Vec};

use crate::{AssetConfig, EventDefinition, SeriesTerms};

/// Governor action payloads. technical-doc.md Section 17.1.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Action {
    SetParam(Symbol, i128),
    AddAsset(AssetConfig),
    UpdateAsset(Address, AssetConfig),
    DisableAsset(Address),
    RegisterDefinition(EventDefinition),
    OpenSeries(SeriesTerms),
    AddKeeper(Address),
    RemoveKeeper(Address),
    AddReporter(Address, Symbol),
    RemoveReporter(Address),
    SetCommittee(Address),
    SetFormula(u32, Vec<u32>, Map<Symbol, i128>),
    SetSeriesWasm(BytesN<32>),
    /// (contract, new wasm hash).
    Upgrade(Address, BytesN<32>),
    Unpause(PauseScope),
    SetSigners(Vec<Address>, u32),
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PauseScope {
    NewCover,
    NewSeries,
    Deposits,
    Signals,
}

/// technical-doc.md Section 12.6.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QueuedAction {
    pub id: u64,
    pub proposer: Address,
    pub action: Action,
    pub approvals: Vec<Address>,
    pub eta: u64,
    pub executed: bool,
    pub cancelled: bool,
}
