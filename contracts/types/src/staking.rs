use soroban_sdk::{contracttype, Address};

/// Identifies one bond held in escrow by Staking (ADR-004). RiskOracle and
/// EventRegistry keep the dispute and event records; Staking holds the USDC.
/// technical-doc.md Section 4.5.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BondKey {
    /// (asset, epoch): a signal dispute bond, locked by RiskOracle.
    SignalDispute(Address, u64),
    /// (event_id): a Tier 2 proposer bond, locked by EventRegistry.
    EventProposal(u64),
    /// (event_id): a challenger bond, locked by EventRegistry.
    EventChallenge(u64),
}
