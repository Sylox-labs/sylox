//! Minimal client interface for `Treasury`, the one contract
//! `Staking` calls into but does not implement. technical-doc.md
//! Section 3.3 (adapters), 12.7 (Treasury). Lists only the functions
//! `Staking` actually calls, not `Treasury`'s full API; a mock
//! contract implementing this trait lives in `test.rs`, never the
//! production build.

use soroban_sdk::{contractclient, Address, Env};
use sylox_types::TreasuryBucket;

/// The slice of `Treasury`'s API (Section 12.7) that `Staking` calls.
#[contractclient(name = "TreasuryClient")]
#[allow(dead_code)]
pub trait Treasury {
    fn deposit(env: Env, from: Address, bucket: TreasuryBucket, amount: i128);
    fn accrue_reward(env: Env, to: Address, bucket: TreasuryBucket, amount: i128) -> i128;
}
