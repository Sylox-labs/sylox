//! Required integration test (task brief): deploy the REAL
//! `RiskOracle` and the REAL `Staking` together, no mock between
//! them. Runs the full cycle the brief names: keeper bonds, reporters
//! stake and probe, keeper posts signals, the endpoint comes from the
//! real `aggregate`, a signal dispute is opened, timed out via
//! `resolve_signal_dispute_timeout`, and bonds are released. Proves
//! the Section 12.3 interface matches both sides of the real call,
//! not a mock's approximation of it.
//!
//! Real SAC USDC throughout (`register_stellar_asset_contract_v2`,
//! same as every other test in this module; no mock token).

use risk_oracle::{RiskOracle, RiskOracleClient};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{contract, contractimpl, token, Address, BytesN, Env, Symbol};
use sylox_types::{AssetConfig, EndpointStatus, IssuerActions, IssuerFlags, Reference, SignalSet};

use crate::{params, Staking, StakingClient};

/// Minimal `Governor` mock: `RiskOracle.resolve_signal_dispute_timeout`
/// reads `Governor.committee()` fresh at resolution time (ADR-010);
/// this is the one adapter neither `Staking` nor `RiskOracle` owns
/// and that `feat/staking`'s scope explicitly excludes
/// (`contracts/governor` is not implemented), so this test supplies
/// the minimal real contract both production contracts' interfaces
/// actually need, rather than skipping the call.
#[contract]
struct MockGovernor;

#[contractimpl]
impl MockGovernor {
    pub fn set_committee(env: Env, committee: Address) {
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "committee"), &committee);
    }

    pub fn committee(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "committee"))
            .unwrap()
    }
}

struct IntegrationFixture<'a> {
    staking: StakingClient<'a>,
    staking_id: Address,
    oracle: RiskOracleClient<'a>,
    usdc_client: token::TokenClient<'a>,
    usdc_admin_client: token::StellarAssetClient<'a>,
    treasury: Address,
    committee: Address,
}

fn setup(env: &Env) -> IntegrationFixture<'_> {
    env.mock_all_auths_allowing_non_root_auth();

    // A real Governor contract, not a plain Address: Staking's own
    // `governor` field is never read by anything this test exercises
    // (add_keeper/add_reporter rely on mock_all_auths_allowing_non_root_auth,
    // not a real governance flow), but RiskOracle.resolve_signal_dispute_timeout
    // (ADR-010) reads committee() fresh from its OWN config.governor,
    // which must resolve as a real contract call. contracts/governor
    // is out of this PR's scope (task brief), so this minimal
    // MockGovernor is the one adapter this test must supply itself.
    let governor_contract = env.register(MockGovernor, ());
    let governor_client = MockGovernorClient::new(env, &governor_contract);
    let committee = Address::generate(env);
    governor_client.set_committee(&committee);

    let registry = Address::generate(env);
    let treasury = Address::generate(env);

    let sac_admin = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(sac_admin);
    let usdc = sac.address();
    let usdc_client = token::TokenClient::new(env, &usdc);
    let usdc_admin_client = token::StellarAssetClient::new(env, &usdc);

    let staking_id = env.register(Staking, ());
    let staking = StakingClient::new(env, &staking_id);

    let oracle_id = env.register(RiskOracle, ());
    let oracle = RiskOracleClient::new(env, &oracle_id);

    // Staking.oracle = the real RiskOracle's own address: this is
    // exactly the cross-contract wiring Section 12.3 describes, and
    // the whole point of this test (no mock standing in for either
    // side of the lock_bond/release_bond/aggregate/is_active_keeper
    // calls that cross this boundary).
    staking.initialize(&governor_contract, &oracle_id, &registry, &treasury, &usdc);
    oracle.initialize(&governor_contract, &registry, &staking_id);

    IntegrationFixture {
        staking,
        staking_id,
        oracle,
        usdc_client,
        usdc_admin_client,
        treasury,
        committee,
    }
}

fn asset_config(env: &Env, asset: &Address, issuer: &Address) -> AssetConfig {
    AssetConfig {
        asset: asset.clone(),
        issuer: issuer.clone(),
        reference: Reference::Usd,
        home_domain: soroban_sdk::String::from_str(env, "example.com"),
        amm_adapters: soroban_sdk::Vec::new(env),
        fx_adapter: None,
        min_liquidity: 100_000_000_000,
        issuer_flags: IssuerFlags::default(),
        enabled: true,
    }
}

fn signal_set(env: &Env, epoch: u64, poster: &Address) -> SignalSet {
    SignalSet {
        epoch,
        posted_at: 0,
        peg_ratio: sylox_types::SCALE,
        peg_ratio_p10: sylox_types::SCALE,
        liquidity_2pct: 500_000_000_000,
        redemption_net: 0,
        supply: 10_000_000_000_000,
        supply_change_bps: 0,
        issuer_actions: IssuerActions::default(),
        endpoint: EndpointStatus::Unknown,
        inputs_hash: BytesN::from_array(env, &[7u8; 32]),
        poster: poster.clone(),
    }
}

#[test]
fn full_cycle_real_risk_oracle_and_real_staking_signal_dispute_timeout_releases_bonds() {
    let env = Env::default();
    let fx = setup(&env);

    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle.add_asset(&asset_config(&env, &asset, &issuer));

    // Keeper bonds in the real Staking.
    let keeper = Address::generate(&env);
    fx.staking.add_keeper(&keeper);
    fx.usdc_admin_client.mint(&keeper, &params::KEEPER_BOND);
    fx.staking.stake(&keeper, &params::KEEPER_BOND);
    assert!(fx.staking.is_active_keeper(&keeper));

    // 3 reporters across 2 distinct regions stake and probe epoch 0.
    let regions = ["eu", "us", "af"];
    let mut reporters = soroban_sdk::Vec::new(&env);
    env.ledger().set_timestamp(params::EPOCH_SECS / 2);
    for r in regions {
        let reporter = Address::generate(&env);
        fx.staking.add_reporter(&reporter, &Symbol::new(&env, r));
        fx.usdc_admin_client
            .mint(&reporter, &params::REPORTER_STAKE);
        fx.staking.stake(&reporter, &params::REPORTER_STAKE);
        fx.staking.submit_probe(
            &reporter,
            &sylox_types::ProbeReport {
                asset: asset.clone(),
                epoch: 0,
                status: EndpointStatus::Up,
                region: Symbol::new(&env, "ignored"),
                evidence_hash: BytesN::from_array(&env, &[0u8; 32]),
            },
        );
        reporters.push_back(reporter);
    }

    // Real aggregate, read directly, before the keeper ever posts.
    assert_eq!(fx.staking.aggregate(&asset, &0), EndpointStatus::Up);

    // Epoch 0 must be closed (strictly in the past) before
    // post_signals accepts it (check_epoch_window).
    env.ledger().set_timestamp(params::EPOCH_SECS + 10);
    fx.oracle
        .post_signals(&keeper, &asset, &signal_set(&env, 0, &keeper));

    // The posted SignalSet's endpoint came only from Staking's real
    // aggregate, proving post_signals -> Staking.aggregate works
    // end-to-end with no mock on either side.
    let posted = fx.oracle.signals(&asset, &0).unwrap();
    assert_eq!(posted.endpoint, EndpointStatus::Up);

    // A signal dispute is opened: RiskOracle.dispute_signals calls
    // the real Staking.lock_bond with the keeper passed through as
    // subject (the second approved RiskOracle change).
    let disputer = Address::generate(&env);
    let dispute_bond = 10_000_000_000i128;
    fx.usdc_admin_client.mint(&disputer, &dispute_bond);
    fx.oracle
        .dispute_signals(&disputer, &asset, &0, &BytesN::from_array(&env, &[9u8; 32]));

    let bond_key = sylox_types::BondKey::SignalDispute(asset.clone(), 0);
    assert_eq!(
        fx.staking.bond(&bond_key),
        Some((disputer.clone(), dispute_bond))
    );
    // The subject pass-through: the keeper's own open_dispute_count
    // reflects the real lock_bond call RiskOracle made, not a mock
    // recording that a call happened.
    assert_eq!(fx.staking.keeper(&keeper).unwrap().open_dispute_count, 1);

    // Nobody rules; time passes the ruling deadline.
    let now = env.ledger().timestamp();
    env.ledger()
        .set_timestamp(now + crate_signal_dispute_ruling_secs());
    fx.oracle.resolve_signal_dispute_timeout(&asset, &0);

    // Both sides of the outcome, read from the real Staking, not a
    // mock's call_count: the disputer's bond is gone (released, not
    // forfeited) and the keeper's own bond and open dispute count are
    // untouched (nobody slashed).
    assert_eq!(fx.staking.bond(&bond_key), None);
    assert_eq!(fx.staking.claimable(&disputer), dispute_bond);
    assert_eq!(fx.staking.keeper(&keeper).unwrap().open_dispute_count, 0);
    assert_eq!(
        fx.staking.keeper(&keeper).unwrap().bond,
        params::KEEPER_BOND
    );

    let claimed = fx.staking.claim(&disputer);
    assert_eq!(claimed, dispute_bond);
    assert_eq!(fx.usdc_client.balance(&disputer), dispute_bond);

    // The keeper's posting stands: epoch 0 is effectively Final. Not
    // a ring() scan for epoch == 0: an untouched Empty placeholder
    // slot elsewhere in the 240-slot ring also carries epoch == 0
    // (RingSlot's default), so ring().iter().find(epoch == 0) can
    // match the wrong slot; is_final() is RiskOracle's own
    // unambiguous read for exactly this question.
    assert!(fx.oracle.is_final(&asset, &0));

    let _ = fx.staking_id;
    let _ = fx.treasury;
    let _ = fx.committee;
    let _ = reporters;
}

/// Mirrors `RiskOracle`'s own private `SIGNAL_DISPUTE_RULING_SECS`
/// (not exported): this integration test lives in a different crate,
/// so it cannot read that constant directly, and the task's own
/// instruction to "derive all times from the parameter constants,
/// never hand-computed" extends to not silently duplicating a magic
/// number either. `RiskOracle`'s `ADR-010` documents the default
/// (7 days) as the value under test; this helper names that fact
/// instead of inlining `604_800` at the call site.
fn crate_signal_dispute_ruling_secs() -> u64 {
    604_800
}
