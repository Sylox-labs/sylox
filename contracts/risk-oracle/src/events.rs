//! RiskOracle events. technical-doc.md Section 13 (as written before
//! this round) specifies topics as `("sylox", "RiskOracle", <event>,
//! <primary key>)`, four topics; this cannot be emitted literally with
//! `soroban-sdk 29.0.0`'s `#[contractevent]` macro, which panics at
//! compile time (`LengthExceedsMax`) for more than 2 custom prefix
//! topics (`stellar-xdr`'s `ScSpecEventV0.prefix_topics` is declared
//! `SCSymbol prefixTopics<2>` in the XDR schema, a hard limit, not a
//! bug).
//!
//! Re-review item C7 (lead decision, recorded as ADR-007): every event
//! below instead emits `("sylox", <event_name>, <primary key>)`, three
//! topics total, dropping the literal `"RiskOracle"` prefix entirely
//! (the emitting contract's own address is already on every event, so
//! a second, redundant "which contract" topic added nothing) in favor
//! of putting the event's own name where an integrator's `getEvents`
//! filter actually wants it: as a topic, not buried in spec metadata
//! only a full client codegen could read. This fits the 2-prefix limit
//! exactly the same way the old convention did; it is not a new
//! workaround, just a different choice of what the 2 prefix topics
//! say. ADR-007 applies this convention to every Sylox contract, not
//! only `RiskOracle`; see the PR's "Spec deviations" section for the
//! Section 13 amendment this motivates in the upcoming spec/v1.2 PR.
//!
//! Review item C2: every row in Section 13's RiskOracle table is defined
//! here (including `endpoint_finalized`, which the review's own C2 list
//! omitted but which is in the spec table it points at; see the PR's
//! "Spec deviations" section for that discrepancy) and emitted with the
//! exact data fields the table lists.

use soroban_sdk::{contractevent, Address, BytesN};
use sylox_types::{Band, EndpointStatus};

#[contractevent(topics = ["sylox", "signals_posted"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignalsPosted {
    #[topic]
    pub asset: Address,
    pub epoch: u64,
    pub keeper: Address,
    pub inputs_hash: BytesN<32>,
    pub pending_until: u64,
}

#[contractevent(topics = ["sylox", "signals_final"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignalsFinal {
    #[topic]
    pub asset: Address,
    pub epoch: u64,
}

#[contractevent(topics = ["sylox", "signals_disputed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignalsDisputed {
    #[topic]
    pub asset: Address,
    pub epoch: u64,
    pub disputer: Address,
    pub alt_hash: BytesN<32>,
}

#[contractevent(topics = ["sylox", "signals_resolved"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignalsResolved {
    #[topic]
    pub asset: Address,
    pub epoch: u64,
    pub keeper_wins: bool,
    pub reason: BytesN<32>,
}

#[contractevent(topics = ["sylox", "endpoint_finalized"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EndpointFinalized {
    #[topic]
    pub asset: Address,
    pub epoch: u64,
    pub status: EndpointStatus,
}

/// ADR-010 (feat/staking, issue #4 fix).
#[contractevent(topics = ["sylox", "signal_dispute_timed_out"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignalDisputeTimedOut {
    #[topic]
    pub asset: Address,
    pub epoch: u64,
    pub disputer: Address,
    pub committee: Address,
}

#[contractevent(topics = ["sylox", "score_updated"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScoreUpdated {
    #[topic]
    pub asset: Address,
    pub epoch: u64,
    pub score: u32,
    pub formula_version: u32,
}

#[contractevent(topics = ["sylox", "band_changed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BandChanged {
    #[topic]
    pub asset: Address,
    pub from: Band,
    pub to: Band,
    pub epoch: u64,
}

#[contractevent(topics = ["sylox", "asset_stale"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetStale {
    #[topic]
    pub asset: Address,
    pub last_epoch: u64,
}

/// technical-doc.md Section 5.9 (v1.5), Section 13.
#[contractevent(topics = ["sylox", "sub_signals_posted"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubSignalsPosted {
    #[topic]
    pub asset: Address,
    pub hour: u64,
    pub sub: u32,
    pub keeper: Address,
    pub inputs_hash: BytesN<32>,
    pub pending_until: u64,
}

#[contractevent(topics = ["sylox", "sub_signals_final"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubSignalsFinal {
    #[topic]
    pub asset: Address,
    pub hour: u64,
    pub sub: u32,
}

#[contractevent(topics = ["sylox", "sub_signals_disputed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubSignalsDisputed {
    #[topic]
    pub asset: Address,
    pub hour: u64,
    pub sub: u32,
    pub disputer: Address,
    pub alt_hash: BytesN<32>,
}

#[contractevent(topics = ["sylox", "sub_signals_resolved"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubSignalsResolved {
    #[topic]
    pub asset: Address,
    pub hour: u64,
    pub sub: u32,
    pub keeper_wins: bool,
}

#[contractevent(topics = ["sylox", "sub_signal_dispute_timed_out"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubSignalDisputeTimedOut {
    #[topic]
    pub asset: Address,
    pub hour: u64,
    pub sub: u32,
    pub disputer: Address,
    pub committee: Address,
}

/// technical-doc.md Section 5.9 S4, Section 13.
#[contractevent(topics = ["sylox", "hour_built"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HourBuilt {
    #[topic]
    pub asset: Address,
    pub hour: u64,
    pub sub_count_final: u32,
    pub coverage_bps: u32,
}

/// technical-doc.md Section 5.9 S1, Section 13.
#[contractevent(topics = ["sylox", "sub_epoch_secs_changed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubEpochSecsChanged {
    #[topic]
    pub asset: Address,
    pub sub_epoch_secs: u64,
    pub effective_from_hour: u64,
}
