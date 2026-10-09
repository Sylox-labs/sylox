#![no_std]

//! Treasury: protocol fees, slashed funds, and the keeper and reporter
//! reward pools, in four `TreasuryBucket`s. technical-doc.md Section
//! 12.7, ADR-004.
//!
//! Scope (feat/treasury): `Governor` is not implemented. `allocate`
//! and `spend` check `governor.require_auth()` directly against the
//! address set at `initialize`, the same pattern `RiskOracle` and
//! `Staking` already use for their own governor-gated calls; the 14
//! day timelock Section 17.2 describes for `TreasuryAllocate`/
//! `TreasurySpend` actions is `Governor`'s own job to enforce once
//! built, not re-implemented here. Tests mock `Governor` with a plain
//! address, the same way `RiskOracle`'s and `Staking`'s own tests do.
//!
//! Lead decision (feat/treasury, per the task brief): one home for
//! each kind of money. `Staking` holds only participant funds
//! (keeper bonds, reporter stakes, locked dispute bonds, and
//! `Claimable` balances owed to participants). `Treasury` holds only
//! protocol funds, in the four buckets below. `Staking`'s previous
//! local reward pool (`RewardPool`/`AccruedReward`/`fund_rewards`/
//! `claim_rewards`, feat/staking's own stand-in before this contract
//! existed) is removed; see `contracts/staking`'s own CHANGELOG-style
//! note in its `lib.rs` for exactly what moved where.
//!
//! Accounting invariants (task brief), tested in `test::property` and
//! noted again at each function below that could threaten them:
//!
//! T1. USDC balance of Treasury >= sum of all bucket balances + sum
//!     of all accrued-but-unclaimed rewards. (`>=`, not `==`: a
//!     direct transfer into this contract with no matching `deposit`
//!     call counts as a donation, tracked by neither side, same
//!     reasoning Section 12.7's own invariant I15 already states.)
//! T2. `accrue_reward` never accrues more than the bucket holds; it
//!     returns the amount actually accrued, which may be less than
//!     requested.
//! T3. USDC leaves Treasury only through `claim_reward` (to the
//!     address it was accrued to) or `spend` (governor, to whatever
//!     address it names). No function here takes an arbitrary
//!     destination address outside those two.
//! T4. `allocate` moves balance between buckets without changing the
//!     total held across all four buckets.

mod error;
mod events;
mod storage;

use soroban_sdk::{contract, contractimpl, token, Address, Env, Symbol};
use sylox_types::TreasuryBucket;

pub use error::Error;

#[contract]
pub struct Treasury;

#[derive(Clone)]
#[soroban_sdk::contracttype]
struct Config {
    governor: Address,
    staking: Address,
    usdc: Address,
}

const CONFIG_KEY: Symbol = soroban_sdk::symbol_short!("CONFIG");

#[contractimpl]
impl Treasury {
    pub fn initialize(
        env: Env,
        governor: Address,
        staking: Address,
        usdc: Address,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&CONFIG_KEY) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(
            &CONFIG_KEY,
            &Config {
                governor,
                staking,
                usdc,
            },
        );
        Ok(())
    }

    /// technical-doc.md Section 12.7: "pulls USDC into the bucket
    /// (Series fees, Staking slashed funds, top ups)". Auth: `from`
    /// itself, whoever that is; this contract does not restrict which
    /// address may deposit into which bucket. When `from` is another
    /// contract's own address (not a human signer), that contract
    /// must call `env.authorize_as_current_contract` before invoking
    /// this function, the same way `Staking`'s own deposit of its
    /// Slashed-bucket share does (see `contracts/staking`'s
    /// `deposit_treasury_share`): the token's own `transfer` call
    /// inside this function is a second hop past `from`'s direct
    /// call into this contract, which Soroban does not auto-authorize
    /// (only the FIRST hop, this call itself, is automatic).
    pub fn deposit(
        env: Env,
        from: Address,
        bucket: TreasuryBucket,
        amount: i128,
    ) -> Result<(), Error> {
        from.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let config = Self::require_config(&env)?;
        let usdc = token::TokenClient::new(&env, &config.usdc);
        usdc.transfer(
            &from,
            soroban_sdk::MuxedAddress::from(env.current_contract_address()),
            &amount,
        );
        let after = storage::get_bucket(&env, bucket)
            .checked_add(amount)
            .ok_or(Error::MathOverflow)?;
        storage::set_bucket(&env, bucket, after);
        events::Deposited {
            bucket,
            from,
            amount,
        }
        .publish(&env);
        Ok(())
    }

    /// technical-doc.md Section 12.7: "accrues min(amount, bucket
    /// balance), returns it". Auth: `staking`, the address set at
    /// `initialize`. Rejects any bucket other than `KeeperRewards` or
    /// `ReporterRewards` (`WrongBucket`): `Fees` and `Slashed` fund
    /// rewards only indirectly, via `allocate`, never a direct
    /// accrual to one address. T2: the accrual is capped at what the
    /// bucket actually holds; never accrues unfunded rewards.
    /// Emits `RewardShortfall` alongside `RewardAccrued` whenever the
    /// bucket could not cover the full request (task brief: "an event
    /// records the shortfall").
    pub fn accrue_reward(
        env: Env,
        to: Address,
        bucket: TreasuryBucket,
        amount: i128,
    ) -> Result<i128, Error> {
        let config = Self::require_config(&env)?;
        config.staking.require_auth();
        if !matches!(
            bucket,
            TreasuryBucket::KeeperRewards | TreasuryBucket::ReporterRewards
        ) {
            return Err(Error::WrongBucket);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let balance = storage::get_bucket(&env, bucket);
        let accrued = amount.min(balance);
        if accrued > 0 {
            storage::set_bucket(&env, bucket, balance - accrued);
            storage::add_accrued(&env, &to, accrued);
        }
        events::RewardAccrued {
            to: to.clone(),
            bucket,
            requested: amount,
            accrued,
        }
        .publish(&env);
        if accrued < amount {
            events::RewardShortfall {
                to,
                bucket,
                requested: amount,
                accrued,
                shortfall: amount - accrued,
            }
            .publish(&env);
        }
        Ok(accrued)
    }

    /// Pays everything accrued to `who`. Auth: `who`.
    pub fn claim_reward(env: Env, who: Address) -> Result<i128, Error> {
        who.require_auth();
        let config = Self::require_config(&env)?;
        let amount = storage::get_accrued(&env, &who);
        if amount <= 0 {
            return Err(Error::NothingToClaim);
        }
        storage::clear_accrued(&env, &who);
        let usdc = token::TokenClient::new(&env, &config.usdc);
        usdc.transfer(
            &env.current_contract_address(),
            soroban_sdk::MuxedAddress::from(who.clone()),
            &amount,
        );
        events::RewardClaimed { who, amount }.publish(&env);
        Ok(amount)
    }

    /// technical-doc.md Section 12.7: "moves funds between buckets
    /// (typically from Fees into the reward pools)". Auth: governor.
    /// T4: moves balance between buckets without changing the total
    /// held across all four; no USDC moves (T3 is unaffected).
    pub fn allocate(
        env: Env,
        from: TreasuryBucket,
        to: TreasuryBucket,
        amount: i128,
    ) -> Result<(), Error> {
        let config = Self::require_config(&env)?;
        config.governor.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let from_balance = storage::get_bucket(&env, from);
        if amount > from_balance {
            return Err(Error::InsufficientBucket);
        }
        storage::set_bucket(&env, from, from_balance - amount);
        let to_balance = storage::get_bucket(&env, to);
        storage::set_bucket(&env, to, to_balance + amount);
        events::Allocated {
            from_bucket: from,
            to_bucket: to,
            amount,
        }
        .publish(&env);
        Ok(())
    }

    /// technical-doc.md Section 12.7: "pays maintenance or committee
    /// costs out of a bucket". Auth: governor. T3: the only other way
    /// USDC leaves this contract besides `claim_reward`.
    pub fn spend(env: Env, bucket: TreasuryBucket, to: Address, amount: i128) -> Result<(), Error> {
        let config = Self::require_config(&env)?;
        config.governor.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let balance = storage::get_bucket(&env, bucket);
        if amount > balance {
            return Err(Error::InsufficientBucket);
        }
        storage::set_bucket(&env, bucket, balance - amount);
        let usdc = token::TokenClient::new(&env, &config.usdc);
        usdc.transfer(
            &env.current_contract_address(),
            soroban_sdk::MuxedAddress::from(to.clone()),
            &amount,
        );
        events::Spent { bucket, to, amount }.publish(&env);
        Ok(())
    }

    // -- reads --

    pub fn balance(env: Env, bucket: TreasuryBucket) -> i128 {
        storage::get_bucket(&env, bucket)
    }

    pub fn accrued(env: Env, who: Address) -> i128 {
        storage::get_accrued(&env, &who)
    }

    fn require_config(env: &Env) -> Result<Config, Error> {
        env.storage()
            .instance()
            .get(&CONFIG_KEY)
            .ok_or(Error::NotInitialized)
    }
}

#[cfg(test)]
mod test;
