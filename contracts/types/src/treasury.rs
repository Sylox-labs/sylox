use soroban_sdk::contracttype;

/// The separately accounted balances the Treasury holds (ADR-004).
/// technical-doc.md Section 4.5.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TreasuryBucket {
    /// Protocol fees on premiums, paid by Series at purchase.
    Fees,
    /// Forfeited bonds and slashed stake, paid by Staking.
    Slashed,
    /// Pays `keeper_reward` per accepted epoch.
    KeeperRewards,
    /// Pays reporters who agreed with the majority.
    ReporterRewards,
}
