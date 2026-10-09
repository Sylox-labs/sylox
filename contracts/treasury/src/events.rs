//! Treasury events. technical-doc.md Section 13, ADR-007. Every event
//! below emits exactly `["sylox", <event_name>]` as its 2 custom
//! prefix topics, followed by whatever single field `#[topic]` marks
//! as the event's primary key, for 3 runtime topics total.
//!
//! `deposited`/`reward_accrued`/`reward_claimed`/`allocated`/`spent`
//! are the 5 events technical-doc.md Section 13 already specifies for
//! `Treasury`. `reward_shortfall` is new, for the "a short bucket
//! caps the accrual, nothing is owed beyond that" case (Section
//! 12.7), so a shortfall is visible onchain, not just inferred from
//! `reward_accrued.accrued < reward_accrued.requested`.

use soroban_sdk::{contractevent, Address};
use sylox_types::TreasuryBucket;

#[contractevent(topics = ["sylox", "deposited"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposited {
    #[topic]
    pub bucket: TreasuryBucket,
    pub from: Address,
    pub amount: i128,
}

#[contractevent(topics = ["sylox", "reward_accrued"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardAccrued {
    #[topic]
    pub to: Address,
    pub bucket: TreasuryBucket,
    pub requested: i128,
    pub accrued: i128,
}

/// New, feat/treasury. Emitted alongside `RewardAccrued` whenever
/// `accrued < requested`: the bucket ran short, so `accrued` is all
/// `to` will ever receive for this call, not a retryable partial
/// result. Lets an indexer or operator see a shortfall without
/// diffing `RewardAccrued`'s own two fields.
#[contractevent(topics = ["sylox", "reward_shortfall"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardShortfall {
    #[topic]
    pub to: Address,
    pub bucket: TreasuryBucket,
    pub requested: i128,
    pub accrued: i128,
    pub shortfall: i128,
}

#[contractevent(topics = ["sylox", "reward_claimed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardClaimed {
    #[topic]
    pub who: Address,
    pub amount: i128,
}

#[contractevent(topics = ["sylox", "allocated"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Allocated {
    #[topic]
    pub from_bucket: TreasuryBucket,
    pub to_bucket: TreasuryBucket,
    pub amount: i128,
}

#[contractevent(topics = ["sylox", "spent"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Spent {
    #[topic]
    pub bucket: TreasuryBucket,
    pub to: Address,
    pub amount: i128,
}
