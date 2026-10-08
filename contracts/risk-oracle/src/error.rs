//! RiskOracle error codes. technical-doc.md Section 14. v1.0 codes keep
//! their numbers; new codes are appended at the end of the 100 range.

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    Paused = 4,
    MathOverflow = 5,
    UnknownAsset = 100,
    KeeperNotActive = 101,
    WrongEpoch = 102,
    EpochAlreadyPosted = 103,
    SanityBoundFailed = 104,
    AmmCrossCheckFailed = 105,
    DisputeWindowClosed = 106,
    WeightsInvalid = 107,
    ReferenceImmutable = 108,
    ReferenceRateUnavailable = 109,
}
