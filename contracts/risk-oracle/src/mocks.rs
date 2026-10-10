//! Minimal mock contracts implementing the client traits in `clients.rs`,
//! for tests only. None of these model real Staking/adapter/Governor
//! business logic (slashing, bonding, probe aggregation, committee
//! rotation); each just returns whatever the test configured, so
//! RiskOracle's own logic is what gets exercised.

#![cfg(test)]

use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, Symbol};
use sylox_types::{BondKey, EndpointStatus, FxRateSource};

/// Mock `Staking`. `is_active_keeper` returns true for every keeper by
/// default (set via `set_active` to test the false path);  `aggregate`
/// returns whatever was last set with `set_aggregate` for that
/// `(asset, epoch)`, or `Unknown` otherwise. Bond and reward calls are
/// recorded (so a test can assert they happened) but move no real funds:
/// there is no USDC token in these tests, matching the PR brief's "bond
/// movement is out of scope" instruction for `RiskOracle` itself.
#[contract]
pub struct MockStaking;

#[contractimpl]
impl MockStaking {
    pub fn set_active(env: Env, keeper: Address, active: bool) {
        env.storage()
            .temporary()
            .set(&StakingKey::Active(keeper), &active);
    }

    pub fn set_aggregate(env: Env, asset: Address, epoch: u64, status: EndpointStatus) {
        env.storage()
            .temporary()
            .set(&StakingKey::Aggregate(asset, epoch), &status);
    }

    pub fn is_active_keeper(env: Env, keeper: Address) -> bool {
        env.storage()
            .temporary()
            .get(&StakingKey::Active(keeper))
            .unwrap_or(true)
    }

    pub fn aggregate(env: Env, asset: Address, epoch: u64) -> EndpointStatus {
        env.storage()
            .temporary()
            .get(&StakingKey::Aggregate(asset, epoch))
            .unwrap_or(EndpointStatus::Unknown)
    }

    pub fn settle_probes(env: Env, asset: Address, epoch: u64) {
        record_call(&env, "settle_probes");
        let _ = (asset, epoch);
    }

    pub fn lock_bond(
        env: Env,
        key: BondKey,
        owner: Address,
        amount: i128,
        subject: Option<Address>,
    ) {
        record_call(&env, "lock_bond");
        let _ = (key, owner, amount, subject);
    }

    pub fn release_bond(env: Env, key: BondKey) {
        record_call(&env, "release_bond");
        let _ = key;
    }

    pub fn forfeit_bond(env: Env, key: BondKey, winner: Option<Address>) {
        record_call(&env, "forfeit_bond");
        let _ = (key, winner);
    }

    pub fn slash(
        env: Env,
        who: Address,
        amount: i128,
        winner: Option<Address>,
        reason: BytesN<32>,
    ) {
        record_call(&env, "slash");
        let _ = (who, amount, winner, reason);
    }

    pub fn reward_keeper(env: Env, keeper: Address, epochs: u32) -> i128 {
        record_call(&env, "reward_keeper");
        // Accumulated across every call for this keeper (a real
        // epoch, once rewarded, is never rewarded again, so a
        // genuinely correct caller's calls for the same keeper only
        // ever add up, never overlap): lets a test assert the total
        // epochs ever credited to a keeper across a whole scenario,
        // not just one call. `last_call_epochs` separately tracks
        // the MOST RECENT call's own argument, for a test that wants
        // to check one specific call never claimed more than one
        // epoch's worth of credit per keeper.
        let total = Self::reward_keeper_epochs(env.clone(), keeper.clone()) + epochs;
        env.storage()
            .temporary()
            .set(&StakingKey::RewardKeeperEpochs(keeper.clone()), &total);
        env.storage()
            .temporary()
            .set(&StakingKey::LastRewardKeeperCall(keeper), &epochs);
        epochs as i128
    }

    /// Section 5.9 S6 (v1.5): the sub-epoch reward path's own mock,
    /// mirroring `reward_keeper`'s accounting but keyed separately so
    /// a test can assert the hourly and sub-epoch paths independently.
    pub fn reward_keeper_sub_epochs(
        env: Env,
        keeper: Address,
        sub_epoch_count: u32,
        sub_epoch_secs: u64,
    ) -> i128 {
        record_call(&env, "reward_keeper_sub_epochs");
        let total =
            Self::reward_keeper_sub_epoch_count(env.clone(), keeper.clone()) + sub_epoch_count;
        env.storage()
            .temporary()
            .set(&StakingKey::RewardKeeperSubEpochs(keeper.clone()), &total);
        let per_sub_epoch = 500_000i128 * sub_epoch_secs as i128 / 3_600;
        per_sub_epoch * sub_epoch_count as i128
    }

    /// Total sub-epochs ever credited to `keeper` via
    /// `reward_keeper_sub_epochs`, across every call so far.
    pub fn reward_keeper_sub_epoch_count(env: Env, keeper: Address) -> u32 {
        env.storage()
            .temporary()
            .get(&StakingKey::RewardKeeperSubEpochs(keeper))
            .unwrap_or(0)
    }

    pub fn call_count(env: Env, name: Symbol) -> u32 {
        env.storage()
            .temporary()
            .get(&StakingKey::CallCount(name))
            .unwrap_or(0)
    }

    /// Total epochs ever credited to `keeper` via `reward_keeper`,
    /// across every call so far.
    pub fn reward_keeper_epochs(env: Env, keeper: Address) -> u32 {
        env.storage()
            .temporary()
            .get(&StakingKey::RewardKeeperEpochs(keeper))
            .unwrap_or(0)
    }

    /// The `epochs` argument `reward_keeper` was called with the most
    /// recent time it was called for `keeper` (0 if never called).
    pub fn last_reward_keeper_call_epochs(env: Env, keeper: Address) -> u32 {
        env.storage()
            .temporary()
            .get(&StakingKey::LastRewardKeeperCall(keeper))
            .unwrap_or(0)
    }
}

fn record_call(env: &Env, name: &str) {
    let symbol = Symbol::new(env, name);
    let count: u32 = env
        .storage()
        .temporary()
        .get(&StakingKey::CallCount(symbol.clone()))
        .unwrap_or(0);
    env.storage()
        .temporary()
        .set(&StakingKey::CallCount(symbol), &(count + 1));
}

#[derive(Clone)]
#[soroban_sdk::contracttype]
enum StakingKey {
    Active(Address),
    Aggregate(Address, u64),
    CallCount(Symbol),
    RewardKeeperEpochs(Address),
    LastRewardKeeperCall(Address),
    RewardKeeperSubEpochs(Address),
}

/// Mock `PriceAdapter`: returns whatever was last set with `set_price`
/// for the asset, or `(0, 0, 0)` if never set (which `check_amm_cross_check`
/// treats as below `min_liquidity` and skips).
#[contract]
pub struct MockPriceAdapter;

#[contractimpl]
impl MockPriceAdapter {
    pub fn set_price(env: Env, asset: Address, price: i128, liquidity: i128, timestamp: u64) {
        env.storage()
            .temporary()
            .set(&PriceKey(asset), &(price, liquidity, timestamp));
    }

    pub fn spot_price(env: Env, asset: Address) -> (i128, i128, u64) {
        env.storage()
            .temporary()
            .get(&PriceKey(asset))
            .unwrap_or((0, 0, 0))
    }
}

#[derive(Clone)]
#[soroban_sdk::contracttype]
struct PriceKey(Address);

/// Mock `FxAdapter`: returns whatever was last set with `set_rate` for
/// `(code, rate_source)`, or fails (panics, matching a real contract
/// erroring) if never set for that pair.
#[contract]
pub struct MockFxAdapter;

#[contractimpl]
impl MockFxAdapter {
    pub fn set_rate(env: Env, code: Symbol, rate_source: FxRateSource, rate: i128, timestamp: u64) {
        env.storage()
            .temporary()
            .set(&FxKey(code, rate_source), &(rate, timestamp));
    }

    pub fn rate(env: Env, code: Symbol, rate_source: FxRateSource) -> (i128, u64) {
        env.storage()
            .temporary()
            .get(&FxKey(code, rate_source))
            .expect("mock FxAdapter: set_rate was never called for this (code, rate_source)")
    }
}

#[derive(Clone)]
#[soroban_sdk::contracttype]
struct FxKey(Symbol, FxRateSource);

/// Mock `Governor`: `committee()` returns whatever was last set with
/// `set_committee`.
#[contract]
pub struct MockGovernor;

#[contractimpl]
impl MockGovernor {
    pub fn set_committee(env: Env, committee: Address) {
        env.storage()
            .temporary()
            .set(&GOVERNOR_COMMITTEE, &committee);
    }

    pub fn committee(env: Env) -> Address {
        env.storage()
            .temporary()
            .get(&GOVERNOR_COMMITTEE)
            .expect("mock Governor: set_committee was never called")
    }
}

const GOVERNOR_COMMITTEE: Symbol = soroban_sdk::symbol_short!("comm");
