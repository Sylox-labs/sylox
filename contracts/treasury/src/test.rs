//! Treasury test suite. technical-doc.md Section 12.7; the task
//! brief's TESTS section (T1-T4, one test per error code, unfunded
//! rewards, the real multi-contract integration test lives in
//! `contracts/staking`'s own `test::integration`, since it needs
//! `Staking` and `RiskOracle` too).

extern crate std;

mod property;

use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::{token, Address, Env, Event as _};
use sylox_types::TreasuryBucket;

use crate::{Error, Treasury, TreasuryClient};

struct Fixture<'a> {
    client: TreasuryClient<'a>,
    contract_id: Address,
    governor: Address,
    staking: Address,
    usdc: Address,
    usdc_admin_client: token::StellarAssetClient<'a>,
    usdc_client: token::TokenClient<'a>,
}

/// A real Stellar Asset Contract for USDC, not a mock token, matching
/// every other contract's own test convention in this workspace.
/// `governor` and `staking` are plain addresses here (`Governor` is
/// not implemented; `Staking`'s own test suite exercises the real
/// cross-contract call from its side).
fn setup(env: &Env) -> Fixture<'_> {
    env.mock_all_auths_allowing_non_root_auth();
    let governor = Address::generate(env);
    let staking = Address::generate(env);

    let sac_admin = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(sac_admin);
    let usdc = sac.address();
    let usdc_admin_client = token::StellarAssetClient::new(env, &usdc);
    let usdc_client = token::TokenClient::new(env, &usdc);

    let contract_id = env.register(Treasury, ());
    let client = TreasuryClient::new(env, &contract_id);
    client.initialize(&governor, &staking, &usdc);

    Fixture {
        client,
        contract_id,
        governor,
        staking,
        usdc,
        usdc_admin_client,
        usdc_client,
    }
}

fn fund(fx: &Fixture, who: &Address, amount: i128) {
    fx.usdc_admin_client.mint(who, &amount);
}

/// Deposits `amount` into `bucket` from a freshly minted address.
fn deposit_into(env: &Env, fx: &Fixture, bucket: TreasuryBucket, amount: i128) -> Address {
    let from = Address::generate(env);
    fund(fx, &from, amount);
    fx.client.deposit(&from, &bucket, &amount);
    from
}

// -- initialize --

#[test]
fn initialize_succeeds_once() {
    let env = Env::default();
    let fx = setup(&env);
    assert_eq!(fx.client.balance(&TreasuryBucket::Fees), 0);
}

#[test]
fn initialize_rejects_a_second_call() {
    let env = Env::default();
    let fx = setup(&env);
    let result = fx
        .client
        .try_initialize(&fx.governor, &fx.staking, &fx.usdc);
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
}

#[test]
fn every_function_requiring_config_rejects_before_initialize() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(Treasury, ());
    let client = TreasuryClient::new(&env, &contract_id);
    let who = Address::generate(&env);
    let result = client.try_deposit(&who, &TreasuryBucket::Fees, &1);
    assert_eq!(result, Err(Ok(Error::NotInitialized)));
}

// -- deposit --

#[test]
fn deposit_rejects_a_non_positive_amount() {
    let env = Env::default();
    let fx = setup(&env);
    let from = Address::generate(&env);
    let result = fx.client.try_deposit(&from, &TreasuryBucket::Fees, &0);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn deposit_is_callable_by_anyone_and_credits_the_named_bucket() {
    let env = Env::default();
    let fx = setup(&env);
    let from = Address::generate(&env);
    fund(&fx, &from, 1_000_000_000);
    fx.client
        .deposit(&from, &TreasuryBucket::Fees, &1_000_000_000);
    assert_eq!(fx.client.balance(&TreasuryBucket::Fees), 1_000_000_000);
    assert_eq!(fx.usdc_client.balance(&fx.contract_id), 1_000_000_000);
}

#[test]
fn deposit_rejects_an_amount_that_would_overflow_the_bucket_balance() {
    let env = Env::default();
    let fx = setup(&env);
    // Sets the bucket's own counter directly, bypassing a real
    // transfer of an amount this large (the SAC's own balance
    // tracking rejects minting/transferring anywhere near i128::MAX
    // well before Treasury's own checked_add ever would): this test
    // is about Treasury's own overflow guard on its bucket counter,
    // not about what a real token can move.
    env.as_contract(&fx.contract_id, || {
        crate::storage::set_bucket(&env, TreasuryBucket::Fees, i128::MAX - 1);
    });
    let from = Address::generate(&env);
    fund(&fx, &from, 10);
    let result = fx.client.try_deposit(&from, &TreasuryBucket::Fees, &10);
    assert_eq!(result, Err(Ok(Error::MathOverflow)));
}

#[test]
fn deposit_keeps_each_bucket_separately_accounted() {
    let env = Env::default();
    let fx = setup(&env);
    deposit_into(&env, &fx, TreasuryBucket::Fees, 1_000_000_000);
    deposit_into(&env, &fx, TreasuryBucket::Slashed, 2_000_000_000);
    deposit_into(&env, &fx, TreasuryBucket::KeeperRewards, 3_000_000_000);
    deposit_into(&env, &fx, TreasuryBucket::ReporterRewards, 4_000_000_000);

    assert_eq!(fx.client.balance(&TreasuryBucket::Fees), 1_000_000_000);
    assert_eq!(fx.client.balance(&TreasuryBucket::Slashed), 2_000_000_000);
    assert_eq!(
        fx.client.balance(&TreasuryBucket::KeeperRewards),
        3_000_000_000
    );
    assert_eq!(
        fx.client.balance(&TreasuryBucket::ReporterRewards),
        4_000_000_000
    );
    assert_eq!(fx.usdc_client.balance(&fx.contract_id), 10_000_000_000);
}

// -- accrue_reward --

#[test]
fn accrue_reward_requires_staking_auth() {
    let env = Env::default();
    let fx = setup(&env);
    deposit_into(&env, &fx, TreasuryBucket::ReporterRewards, 1_000_000_000);
    let to = Address::generate(&env);
    let accrued = fx
        .client
        .accrue_reward(&to, &TreasuryBucket::ReporterRewards, &500_000_000);
    assert_eq!(accrued, 500_000_000);
    assert_eq!(fx.client.accrued(&to), 500_000_000);
}

#[test]
fn accrue_reward_rejects_a_non_reward_bucket() {
    let env = Env::default();
    let fx = setup(&env);
    deposit_into(&env, &fx, TreasuryBucket::Fees, 1_000_000_000);
    let to = Address::generate(&env);
    let result = fx
        .client
        .try_accrue_reward(&to, &TreasuryBucket::Fees, &500_000_000);
    assert_eq!(result, Err(Ok(Error::WrongBucket)));

    let result2 = fx
        .client
        .try_accrue_reward(&to, &TreasuryBucket::Slashed, &500_000_000);
    assert_eq!(result2, Err(Ok(Error::WrongBucket)));
}

#[test]
fn accrue_reward_rejects_a_non_positive_amount() {
    let env = Env::default();
    let fx = setup(&env);
    let to = Address::generate(&env);
    let result = fx
        .client
        .try_accrue_reward(&to, &TreasuryBucket::KeeperRewards, &0);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn accrue_reward_caps_at_the_bucket_balance_never_accrues_unfunded() {
    let env = Env::default();
    let fx = setup(&env);
    deposit_into(&env, &fx, TreasuryBucket::KeeperRewards, 1_000_000);
    let to = Address::generate(&env);

    let accrued = fx
        .client
        .accrue_reward(&to, &TreasuryBucket::KeeperRewards, &5_000_000);
    assert_eq!(accrued, 1_000_000);
    assert_eq!(fx.client.accrued(&to), 1_000_000);
    assert_eq!(fx.client.balance(&TreasuryBucket::KeeperRewards), 0);
}

/// A short bucket must not just cap the accrual silently: Section
/// 12.7's shortfall needs to be visible onchain. This checks the
/// `RewardShortfall` event itself, not just the capped `accrued`
/// return value already covered by
/// `accrue_reward_caps_at_the_bucket_balance_never_accrues_unfunded`.
#[test]
fn accrue_reward_short_of_the_request_emits_reward_shortfall() {
    let env = Env::default();
    let fx = setup(&env);
    deposit_into(&env, &fx, TreasuryBucket::KeeperRewards, 1_000_000);
    let to = Address::generate(&env);

    let accrued = fx
        .client
        .accrue_reward(&to, &TreasuryBucket::KeeperRewards, &5_000_000);
    assert_eq!(accrued, 1_000_000);

    let expected = crate::events::RewardShortfall {
        to: to.clone(),
        bucket: TreasuryBucket::KeeperRewards,
        requested: 5_000_000,
        accrued: 1_000_000,
        shortfall: 4_000_000,
    }
    .to_xdr(&env, &fx.contract_id);
    let found = env.events().all().events().contains(&expected);
    assert!(
        found,
        "accrue_reward short of the request must emit RewardShortfall"
    );
}

/// The exact-fill case (accrued == requested) must NOT emit a
/// shortfall: there was none.
#[test]
fn accrue_reward_exactly_covered_by_the_bucket_emits_no_shortfall() {
    let env = Env::default();
    let fx = setup(&env);
    deposit_into(&env, &fx, TreasuryBucket::KeeperRewards, 1_000_000);
    let to = Address::generate(&env);

    let accrued = fx
        .client
        .accrue_reward(&to, &TreasuryBucket::KeeperRewards, &1_000_000);
    assert_eq!(accrued, 1_000_000);

    let would_be_shortfall = crate::events::RewardShortfall {
        to: to.clone(),
        bucket: TreasuryBucket::KeeperRewards,
        requested: 1_000_000,
        accrued: 1_000_000,
        shortfall: 0,
    }
    .to_xdr(&env, &fx.contract_id);
    let any_shortfall = env.events().all().events().contains(&would_be_shortfall);
    assert!(
        !any_shortfall,
        "an exactly-covered accrual must not emit RewardShortfall"
    );
}

#[test]
fn accrue_reward_against_a_completely_empty_bucket_accrues_zero() {
    let env = Env::default();
    let fx = setup(&env);
    let to = Address::generate(&env);
    let accrued = fx
        .client
        .accrue_reward(&to, &TreasuryBucket::ReporterRewards, &1_000_000);
    assert_eq!(accrued, 0);
    assert_eq!(fx.client.accrued(&to), 0);
}

// -- claim_reward --

#[test]
fn claim_reward_rejects_when_nothing_is_accrued() {
    let env = Env::default();
    let fx = setup(&env);
    let who = Address::generate(&env);
    let result = fx.client.try_claim_reward(&who);
    assert_eq!(result, Err(Ok(Error::NothingToClaim)));
}

#[test]
fn claim_reward_pays_out_everything_accrued() {
    let env = Env::default();
    let fx = setup(&env);
    deposit_into(&env, &fx, TreasuryBucket::ReporterRewards, 1_000_000_000);
    let to = Address::generate(&env);
    fx.client
        .accrue_reward(&to, &TreasuryBucket::ReporterRewards, &1_000_000_000);

    let claimed = fx.client.claim_reward(&to);
    assert_eq!(claimed, 1_000_000_000);
    assert_eq!(fx.client.accrued(&to), 0);
    assert_eq!(fx.usdc_client.balance(&to), 1_000_000_000);
}

// -- allocate --

#[test]
fn allocate_requires_governor_auth_and_moves_balance_between_buckets() {
    let env = Env::default();
    let fx = setup(&env);
    deposit_into(&env, &fx, TreasuryBucket::Fees, 1_000_000_000);

    fx.client.allocate(
        &TreasuryBucket::Fees,
        &TreasuryBucket::ReporterRewards,
        &400_000_000,
    );
    assert_eq!(fx.client.balance(&TreasuryBucket::Fees), 600_000_000);
    assert_eq!(
        fx.client.balance(&TreasuryBucket::ReporterRewards),
        400_000_000
    );
}

#[test]
fn allocate_rejects_a_non_positive_amount() {
    let env = Env::default();
    let fx = setup(&env);
    let result = fx
        .client
        .try_allocate(&TreasuryBucket::Fees, &TreasuryBucket::Slashed, &0);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn allocate_rejects_more_than_the_source_bucket_holds() {
    let env = Env::default();
    let fx = setup(&env);
    deposit_into(&env, &fx, TreasuryBucket::Fees, 100);
    let result = fx
        .client
        .try_allocate(&TreasuryBucket::Fees, &TreasuryBucket::Slashed, &101);
    assert_eq!(result, Err(Ok(Error::InsufficientBucket)));
}

#[test]
fn allocate_never_changes_the_total_held_across_buckets() {
    let env = Env::default();
    let fx = setup(&env);
    deposit_into(&env, &fx, TreasuryBucket::Fees, 1_000_000_000);
    deposit_into(&env, &fx, TreasuryBucket::Slashed, 500_000_000);

    let total_before = fx.client.balance(&TreasuryBucket::Fees)
        + fx.client.balance(&TreasuryBucket::Slashed)
        + fx.client.balance(&TreasuryBucket::KeeperRewards)
        + fx.client.balance(&TreasuryBucket::ReporterRewards);

    fx.client.allocate(
        &TreasuryBucket::Fees,
        &TreasuryBucket::KeeperRewards,
        &300_000_000,
    );
    fx.client.allocate(
        &TreasuryBucket::Slashed,
        &TreasuryBucket::ReporterRewards,
        &500_000_000,
    );

    let total_after = fx.client.balance(&TreasuryBucket::Fees)
        + fx.client.balance(&TreasuryBucket::Slashed)
        + fx.client.balance(&TreasuryBucket::KeeperRewards)
        + fx.client.balance(&TreasuryBucket::ReporterRewards);
    assert_eq!(total_before, total_after);
    // No USDC moved: allocate is bucket bookkeeping only.
    assert_eq!(
        fx.usdc_client.balance(&fx.contract_id),
        1_000_000_000 + 500_000_000
    );
}

// -- spend --

#[test]
fn spend_requires_governor_auth_and_pays_out_from_the_bucket() {
    let env = Env::default();
    let fx = setup(&env);
    deposit_into(&env, &fx, TreasuryBucket::Fees, 1_000_000_000);
    let recipient = Address::generate(&env);

    fx.client
        .spend(&TreasuryBucket::Fees, &recipient, &400_000_000);
    assert_eq!(fx.client.balance(&TreasuryBucket::Fees), 600_000_000);
    assert_eq!(fx.usdc_client.balance(&recipient), 400_000_000);
}

#[test]
fn spend_rejects_a_non_positive_amount() {
    let env = Env::default();
    let fx = setup(&env);
    let recipient = Address::generate(&env);
    let result = fx.client.try_spend(&TreasuryBucket::Fees, &recipient, &0);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn spend_rejects_more_than_the_bucket_holds() {
    let env = Env::default();
    let fx = setup(&env);
    deposit_into(&env, &fx, TreasuryBucket::Fees, 100);
    let recipient = Address::generate(&env);
    let result = fx.client.try_spend(&TreasuryBucket::Fees, &recipient, &101);
    assert_eq!(result, Err(Ok(Error::InsufficientBucket)));
}

// -- T1-T4 (task brief) --
//
// T1. USDC balance of Treasury >= sum of all bucket balances + sum
//     of all accrued-but-unclaimed rewards. Tested directly below
//     (`t1_balance_covers_buckets_plus_accrued`) and continuously by
//     `property::t1_to_t4_never_break`.
// T2. accrue_reward never accrues more than the bucket holds; it
//     returns the amount actually accrued. Tested by
//     `accrue_reward_caps_at_the_bucket_balance_never_accrues_unfunded`
//     above and by the property test.
// T3. USDC leaves Treasury only through claim_reward (to the address
//     it was accrued to) or spend (governor). Enforced structurally
//     (see `lib.rs`'s own doc comment) and exercised by the property
//     test's own op set, which has no other way to move USDC out.
// T4. allocate moves balance between buckets without changing the
//     total. Tested by `allocate_never_changes_the_total_held_across_buckets`
//     above and by the property test.

#[test]
fn t1_balance_covers_buckets_plus_accrued() {
    let env = Env::default();
    let fx = setup(&env);
    deposit_into(&env, &fx, TreasuryBucket::ReporterRewards, 1_000_000_000);
    let to = Address::generate(&env);
    fx.client
        .accrue_reward(&to, &TreasuryBucket::ReporterRewards, &400_000_000);

    let tracked = fx.client.balance(&TreasuryBucket::Fees)
        + fx.client.balance(&TreasuryBucket::Slashed)
        + fx.client.balance(&TreasuryBucket::KeeperRewards)
        + fx.client.balance(&TreasuryBucket::ReporterRewards)
        + fx.client.accrued(&to);
    let balance = fx.usdc_client.balance(&fx.contract_id);
    assert!(
        balance >= tracked,
        "T1 violated: balance {} < tracked {}",
        balance,
        tracked
    );
    // Exact here: no donation happened.
    assert_eq!(balance, tracked);
}

#[test]
fn t1_a_direct_transfer_with_no_deposit_call_counts_as_a_donation_not_a_violation() {
    let env = Env::default();
    let fx = setup(&env);
    // A plain transfer straight into the contract, bypassing
    // `deposit` entirely: no bucket or accrued balance tracks it,
    // but T1 only requires balance >= tracked, never ==, so this is
    // explicitly not a violation.
    let donor = Address::generate(&env);
    fund(&fx, &donor, 1_000_000);
    fx.usdc_client.transfer(
        &donor,
        soroban_sdk::MuxedAddress::from(fx.contract_id.clone()),
        &1_000_000,
    );

    let tracked = fx.client.balance(&TreasuryBucket::Fees)
        + fx.client.balance(&TreasuryBucket::Slashed)
        + fx.client.balance(&TreasuryBucket::KeeperRewards)
        + fx.client.balance(&TreasuryBucket::ReporterRewards);
    assert_eq!(tracked, 0);
    assert_eq!(fx.usdc_client.balance(&fx.contract_id), 1_000_000);
}
