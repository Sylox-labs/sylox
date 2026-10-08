//! RiskOracle error codes. technical-doc.md Section 14. v1.0 codes keep
//! their numbers; new codes are appended at the end of the 100 range.

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    /// Never actually returned by any call in this contract: every
    /// authorization check (`add_asset`, `update_asset`, `set_formula`,
    /// `post_signals`, `dispute_signals`, `resolve_signal_dispute`,
    /// `set_event_band`, `clear_event_band`, `set_event_in_progress`)
    /// goes through Soroban's native `Address::require_auth()`, which
    /// traps the host call directly rather than returning a `Result`
    /// this contract could wrap in `Error::Unauthorized`. Kept for
    /// `technical-doc.md` Section 14 code-number compatibility; see
    /// `missing_auth_traps_natively_rather_than_returning_unauthorized`
    /// in test.rs and the PR's "Review fixes" section for why this is
    /// documented as unreachable rather than tested as reachable.
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
    /// Distinct from `SanityBoundFailed` (104), which is about one posted
    /// `SignalSet`'s fields; this is about computing the score from the
    /// ring (not enough history, or a required window read came back
    /// empty), a different failure mode a caller may want to handle
    /// differently (for example: retry later vs. a permanently bad
    /// posting). Review item "Aggregation failures must not reuse
    /// SanityBoundFailed."
    AggregationFailed = 110,
    /// `add_asset` / `update_asset` reject `Reference::Asset` in v1
    /// (review decision D3): no USD rate is defined anywhere in the spec
    /// for an asset pegged reference (see the PR's "Spec deviations").
    ReferenceNotSupported = 111,
    /// ADR-010 (feat/staking, issue #4 fix): `resolve_signal_dispute_timeout`
    /// called before `SIGNAL_DISPUTE_RULING_SECS` has passed since the
    /// dispute opened. Named to match ADR-002's `RulingDeadlineNotReached`
    /// precedent for the analogous event-ruling timeout.
    RulingDeadlineNotReached = 112,
}
