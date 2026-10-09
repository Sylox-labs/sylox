//! Staking events. technical-doc.md Section 13, ADR-007. Every event
//! below emits exactly `["sylox", <event_name>]` as its 2 custom
//! prefix topics (the XDR limit `soroban-sdk 29.0.0`'s
//! `#[contractevent]` macro enforces; see `risk-oracle`'s own
//! `events.rs` for the full derivation), followed by whatever single
//! field `#[topic]` marks as the event's primary key (Section 13's own
//! "Primary key topic" column), for 3 runtime topics total.
//!
//! `staked`/`unstaked`/`probe_submitted`/`probes_settled`/`bond_locked`/
//! `bond_released`/`bond_forfeited`/`slashed`/`claimed` are the 9
//! events technical-doc.md Section 13 already specifies for `Staking`.
//! `keeper_removed`, `reporter_removed` and `keeper_bond_withdrawn` are
//! new, for functions this build adds beyond Section 12.3's literal
//! list (the removal/exit-delay flow); see the PR's "Spec deviations"
//! section for the Section 13 amendment this motivates in the next
//! spec update.
//!
//! feat/treasury: `rewards_funded` and `staking_reward_claimed`
//! (feat/staking's own stand-in events, for the local reward pool
//! this contract no longer holds) are removed. `probes_settled` and
//! `slashed`/`bond_forfeited`'s `to_treasury` field are unchanged:
//! they still report how much a settlement rewarded or a slash/
//! forfeit sent toward the treasury, now via a real
//! `Treasury.deposit` call (which emits its own `Deposited` event on
//! `Treasury`'s side) rather than a local `Claimable` credit.

use soroban_sdk::{contractevent, Address, BytesN};
use sylox_types::{BondKey, EndpointStatus};

#[contractevent(topics = ["sylox", "staked"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Staked {
    #[topic]
    pub who: Address,
    pub amount: i128,
    pub total_after: i128,
}

#[contractevent(topics = ["sylox", "unstaked"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Unstaked {
    #[topic]
    pub who: Address,
    pub amount: i128,
    pub total_after: i128,
}

#[contractevent(topics = ["sylox", "probe_submitted"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProbeSubmitted {
    #[topic]
    pub asset: Address,
    pub reporter: Address,
    pub epoch: u64,
    pub status: EndpointStatus,
    pub region: soroban_sdk::Symbol,
}

#[contractevent(topics = ["sylox", "probes_settled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProbesSettled {
    #[topic]
    pub asset: Address,
    pub epoch: u64,
    pub aggregate: EndpointStatus,
    pub rewarded: u32,
    pub faulted: u32,
}

#[contractevent(topics = ["sylox", "bond_locked"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BondLocked {
    #[topic]
    pub owner: Address,
    pub key: BondKey,
    pub amount: i128,
}

#[contractevent(topics = ["sylox", "bond_released"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BondReleased {
    #[topic]
    pub owner: Address,
    pub key: BondKey,
    pub amount: i128,
}

#[contractevent(topics = ["sylox", "bond_forfeited"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BondForfeited {
    #[topic]
    pub owner: Address,
    pub key: BondKey,
    pub amount: i128,
    pub winner: Option<Address>,
    pub to_treasury: i128,
}

#[contractevent(topics = ["sylox", "slashed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Slashed {
    #[topic]
    pub who: Address,
    /// The amount actually deducted from `who`'s bond or stake and
    /// split between `winner`/`to_treasury` below. Never exceeds what
    /// `who` actually held at the time (S1, review fix S5): a caller
    /// requesting more than that gets `amount == requested_amount`
    /// capped down, not the request honored past what exists.
    pub amount: i128,
    /// The amount the caller asked `slash` to take, before capping
    /// against `who`'s actual remaining balance. Equal to `amount`
    /// unless the request exceeded what `who` held.
    pub requested_amount: i128,
    pub winner: Option<Address>,
    pub to_treasury: i128,
    pub reason: BytesN<32>,
    pub suspended: bool,
}

#[contractevent(topics = ["sylox", "claimed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Claimed {
    #[topic]
    pub who: Address,
    pub amount: i128,
}

/// New, feat/staking.
#[contractevent(topics = ["sylox", "keeper_removed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeeperRemoved {
    #[topic]
    pub keeper: Address,
    pub removed_at: u64,
    pub withdrawable_at: u64,
}

/// New, feat/staking.
#[contractevent(topics = ["sylox", "reporter_removed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReporterRemoved {
    #[topic]
    pub reporter: Address,
    pub removed_at: u64,
    pub withdrawable_at: u64,
}

/// New, feat/staking.
#[contractevent(topics = ["sylox", "keeper_bond_withdrawn"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeeperBondWithdrawn {
    #[topic]
    pub keeper: Address,
    pub amount: i128,
}
