//! RiskOracle events. technical-doc.md Section 13 specifies topics as
//! `("sylox", "RiskOracle", <event>, <primary key>)`, four topics; this
//! cannot be emitted literally with `soroban-sdk 29.0.0`'s
//! `#[contractevent]` macro, which panics at compile time
//! (`LengthExceedsMax`) for more than 2 custom prefix topics. This is a
//! hard limit, not a bug: `stellar-xdr`'s `ScSpecEventV0.prefix_topics`
//! is declared `SCSymbol prefixTopics<2>` in the XDR schema. Every event
//! below therefore emits exactly 3 runtime topics: `"sylox"`,
//! `"RiskOracle"`, then the `#[topic]`-marked `asset` field (every
//! RiskOracle event's primary key per Section 13). The event's own
//! identity (`signals_posted`, `band_changed`, etc.) is not a 4th
//! literal topic; it lives in the struct's own name, which
//! `#[contractevent]` records in the contract's spec metadata (visible
//! to any indexer or generated client reading the contract, the same way
//! it already reads which fields are topics vs. data), and the event's
//! Rust type lets any caller of this contract from another Soroban
//! contract distinguish them by type regardless. Flagged in the PR's
//! "Spec deviations" section: Section 13's literal 4-topic convention
//! needs amending for every contract in this codebase, not just
//! `RiskOracle`, once this limitation is confirmed against the other
//! contracts' own event definitions.
//!
//! Review item C2: every row in Section 13's RiskOracle table is defined
//! here (including `endpoint_finalized`, which the review's own C2 list
//! omitted but which is in the spec table it points at; see the PR's
//! "Spec deviations" section for that discrepancy) and emitted with the
//! exact data fields the table lists.

use soroban_sdk::{contractevent, Address, BytesN};
use sylox_types::{Band, EndpointStatus};

#[contractevent(topics = ["sylox", "RiskOracle"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignalsPosted {
    #[topic]
    pub asset: Address,
    pub epoch: u64,
    pub keeper: Address,
    pub inputs_hash: BytesN<32>,
    pub pending_until: u64,
}

#[contractevent(topics = ["sylox", "RiskOracle"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignalsFinal {
    #[topic]
    pub asset: Address,
    pub epoch: u64,
}

#[contractevent(topics = ["sylox", "RiskOracle"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignalsDisputed {
    #[topic]
    pub asset: Address,
    pub epoch: u64,
    pub disputer: Address,
    pub alt_hash: BytesN<32>,
}

#[contractevent(topics = ["sylox", "RiskOracle"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignalsResolved {
    #[topic]
    pub asset: Address,
    pub epoch: u64,
    pub keeper_wins: bool,
    pub reason: BytesN<32>,
}

#[contractevent(topics = ["sylox", "RiskOracle"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EndpointFinalized {
    #[topic]
    pub asset: Address,
    pub epoch: u64,
    pub status: EndpointStatus,
}

#[contractevent(topics = ["sylox", "RiskOracle"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScoreUpdated {
    #[topic]
    pub asset: Address,
    pub epoch: u64,
    pub score: u32,
    pub formula_version: u32,
}

#[contractevent(topics = ["sylox", "RiskOracle"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BandChanged {
    #[topic]
    pub asset: Address,
    pub from: Band,
    pub to: Band,
    pub epoch: u64,
}

#[contractevent(topics = ["sylox", "RiskOracle"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetStale {
    #[topic]
    pub asset: Address,
    pub last_epoch: u64,
}
