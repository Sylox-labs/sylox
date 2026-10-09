//! EventRegistry events. technical-doc.md Section 13, ADR-007. Every
//! event below emits exactly `["sylox", <event_name>]` as its 2 custom
//! prefix topics, followed by `asset` (every row in Section 13's own
//! table keys on `asset`), for 3 runtime topics total.

use soroban_sdk::{contractevent, Address, BytesN};
use sylox_types::EventKind;

#[contractevent(topics = ["sylox", "definition_registered"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DefinitionRegistered {
    #[topic]
    pub asset: Address,
    pub kind: EventKind,
    pub version: u32,
    pub previous_version: u32,
}

#[contractevent(topics = ["sylox", "event_proposed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventProposed {
    #[topic]
    pub asset: Address,
    pub event_id: u64,
    pub kind: EventKind,
    pub def_version: u32,
    pub tier: u32,
    pub window_start: u64,
    pub proposer: Address,
    pub evidence: BytesN<32>,
}

#[contractevent(topics = ["sylox", "event_challenged"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventChallenged {
    #[topic]
    pub asset: Address,
    pub event_id: u64,
    pub challenger: Address,
    pub evidence: BytesN<32>,
}

#[contractevent(topics = ["sylox", "event_escalated"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventEscalated {
    #[topic]
    pub asset: Address,
    pub event_id: u64,
    pub escalated_at: u64,
    pub ruling_deadline: u64,
}

#[contractevent(topics = ["sylox", "event_declared"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventDeclared {
    #[topic]
    pub asset: Address,
    pub event_id: u64,
    pub kind: EventKind,
    pub def_version: u32,
    pub window_start: u64,
    pub declared_at: u64,
}

#[contractevent(topics = ["sylox", "event_rejected"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventRejected {
    #[topic]
    pub asset: Address,
    pub event_id: u64,
    pub reason: BytesN<32>,
}

#[contractevent(topics = ["sylox", "event_cured"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventCured {
    #[topic]
    pub asset: Address,
    pub event_id: u64,
}

#[contractevent(topics = ["sylox", "ruling_timed_out"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RulingTimedOut {
    #[topic]
    pub asset: Address,
    pub event_id: u64,
    /// `true` if the default outcome was Declared, `false` if Rejected.
    pub outcome_declared: bool,
    pub committee: Address,
    pub misses_after: u32,
}
