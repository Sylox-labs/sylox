//! Required integration test (task brief): the real `RiskOracle`,
//! `Staking` and `Treasury`, no mock anywhere between them, against a
//! real USDC SAC. Full cycle: a real depeg posted by a keeper,
//! proposed, finalized to Declared, the band becomes `Event`; and a
//! separate challenged event ruled Declared, with the challenger's
//! forfeited bond reaching `Treasury`'s `Slashed` bucket via a real
//! `deposit` call (ADR-012). Every balance asserted at the end.

use risk_oracle::{RiskOracle, RiskOracleClient};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{contract, contractimpl, token, Address, BytesN, Env, Symbol};
use sylox_types::{
    AssetConfig, Band, EndpointStatus, EventKind, EventState, IssuerActions, IssuerFlags,
    Reference, SignalSet, TreasuryBucket,
};
use treasury::{Treasury, TreasuryClient};

use crate::{EventRegistry, EventRegistryClient};

/// Minimal real `Governor`: `EventRegistry.rule` and
/// `RiskOracle.resolve_signal_dispute*` both read `committee()` fresh
/// (ADR-010); `Governor` itself is out of scope for this feature,
/// matching every other integration test in this workspace's own
/// convention (`staking::test::integration`'s own `MockGovernor`).
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

struct Fixture<'a> {
    registry: EventRegistryClient<'a>,
    staking: staking::StakingClient<'a>,
    oracle: RiskOracleClient<'a>,
    treasury: TreasuryClient<'a>,
    usdc_client: token::TokenClient<'a>,
    usdc_admin_client: token::StellarAssetClient<'a>,
    committee: Address,
}

fn setup(env: &Env) -> Fixture<'_> {
    env.mock_all_auths_allowing_non_root_auth();

    let governor_contract = env.register(MockGovernor, ());
    let governor_client = MockGovernorClient::new(env, &governor_contract);
    let committee = Address::generate(env);
    governor_client.set_committee(&committee);

    let registry_id = env.register(EventRegistry, ());
    let oracle_id = env.register(RiskOracle, ());
    let staking_id = env.register(staking::Staking, ());
    let treasury_id = env.register(Treasury, ());

    let sac_admin = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(sac_admin);
    let usdc = sac.address();
    let usdc_client = token::TokenClient::new(env, &usdc);
    let usdc_admin_client = token::StellarAssetClient::new(env, &usdc);

    let treasury = TreasuryClient::new(env, &treasury_id);
    treasury.initialize(&governor_contract, &staking_id, &usdc);

    let staking = staking::StakingClient::new(env, &staking_id);
    staking.initialize(
        &governor_contract,
        &oracle_id,
        &registry_id,
        &treasury_id,
        &usdc,
    );

    let oracle = RiskOracleClient::new(env, &oracle_id);
    oracle.initialize(&governor_contract, &registry_id, &staking_id);

    let factory = Address::generate(env);
    let registry = EventRegistryClient::new(env, &registry_id);
    registry.initialize(&governor_contract, &oracle_id, &staking_id, &factory, &usdc);

    Fixture {
        registry,
        staking,
        oracle,
        treasury,
        usdc_client,
        usdc_admin_client,
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

fn depeg_definition(asset: &Address) -> sylox_types::EventDefinition {
    sylox_types::EventDefinition {
        asset: asset.clone(),
        kind: EventKind::Depeg,
        version: 0,
        reference: Reference::Usd,
        depeg_threshold: 9_500_000,
        depeg_window_secs: 259_200,
        max_missing_epochs: 6,
        cure_threshold: 9_800_000,
        freeze_pct_bps: 0,
        auth_revocation_threshold: 0,
        mint_spike_bps: 0,
        halt_window_secs: 0,
        challenge_secs: 86_400,
        ruling_deadline_secs: 1_209_600,
    }
}

fn signal_set(env: &Env, keeper: &Address, epoch: u64, peg_ratio: i128) -> SignalSet {
    SignalSet {
        epoch,
        posted_at: 0,
        peg_ratio,
        peg_ratio_p10: peg_ratio,
        liquidity_2pct: 500_000_000_000,
        redemption_net: 0,
        supply: 10_000_000_000_000,
        supply_change_bps: 0,
        issuer_actions: IssuerActions::default(),
        endpoint: EndpointStatus::Unknown,
        inputs_hash: BytesN::from_array(env, &[7u8; 32]),
        poster: keeper.clone(),
    }
}

const EPOCH_SECS: u64 = 3_600;

/// Mirrors `Staking`'s own private `params::KEEPER_BOND` (not
/// exported): this integration test lives in a different crate, so
/// it cannot read that constant directly, the same reasoning
/// `staking::test::integration`'s own `crate_signal_dispute_ruling_secs`
/// helper already documents for the analogous `RiskOracle` constant.
const KEEPER_BOND: i128 = 50_000_000_000;

fn post_run(
    env: &Env,
    oracle: &RiskOracleClient,
    keeper: &Address,
    asset: &Address,
    start_epoch: u64,
    count: u64,
    peg_ratio: i128,
) {
    for i in 0..count {
        let epoch = start_epoch + i;
        env.ledger().set_timestamp((epoch + 1) * EPOCH_SECS);
        oracle.post_signals(keeper, asset, &signal_set(env, keeper, epoch, peg_ratio));
    }
}

/// `full_cycle_real_risk_oracle_real_staking_real_treasury_and_event_registry`:
/// a real depeg, proposed, finalized to Declared, the band becomes
/// `Event`; then, separately, a challenged event ruled Declared, with
/// the loser's forfeited bond reaching `Treasury`'s `Slashed` bucket.
#[test]
fn full_cycle_real_risk_oracle_real_staking_real_treasury_and_event_registry() {
    let env = Env::default();
    let fx = setup(&env);

    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle.add_asset(&asset_config(&env, &asset, &issuer));
    fx.registry.register_definition(&depeg_definition(&asset));

    // A keeper bonds (real Staking) and posts a genuine 240 epoch
    // depeg pattern: 168 healthy baseline, then 72 failing epochs.
    let keeper = Address::generate(&env);
    fx.staking.add_keeper(&keeper);
    fx.usdc_admin_client.mint(&keeper, &KEEPER_BOND);
    fx.staking.stake(&keeper, &KEEPER_BOND);
    assert!(fx.staking.is_active_keeper(&keeper));

    post_run(&env, &fx.oracle, &keeper, &asset, 0, 168, 9_900_000);
    post_run(&env, &fx.oracle, &keeper, &asset, 168, 72, 9_000_000);
    let now = env.ledger().timestamp();
    env.ledger().set_timestamp(now + 7_200 + 1);

    // propose_tier1: the real ring, read from the real RiskOracle.
    let proposer = Address::generate(&env);
    let id = fx
        .registry
        .propose_tier1(&proposer, &asset, &EventKind::Depeg, &1);
    let record = fx.registry.event(&id).unwrap();
    assert_eq!(record.state, EventState::Proposed);
    assert!(fx.registry.in_progress(&asset));

    // Nobody challenges; finalize after challenge_secs, with the cure
    // window's own epochs never posted and past their own backfill
    // window, so the cure check resolves to Declared.
    let after = now + 7_200 + 1 + 86_400 + 259_200 + 7_200 + 1;
    env.ledger().set_timestamp(after);
    fx.registry.finalize(&id);

    let record = fx.registry.event(&id).unwrap();
    assert_eq!(record.state, EventState::Declared);
    assert_eq!(
        fx.oracle.band(&asset),
        Band::Event,
        "real set_event_band call"
    );
    assert!(
        !fx.oracle.event_in_progress(&asset),
        "real set_event_in_progress(false) call, no other kind still live"
    );
    assert!(fx.registry.has_declared(&asset));

    // -- separate challenged event, on a separate asset, ruled Declared --

    let asset2 = Address::generate(&env);
    let issuer2 = Address::generate(&env);
    fx.oracle.add_asset(&asset_config(&env, &asset2, &issuer2));
    fx.registry.register_definition(&depeg_definition(&asset2));

    post_run(&env, &fx.oracle, &keeper, &asset2, 0, 168, 9_900_000);
    post_run(&env, &fx.oracle, &keeper, &asset2, 168, 72, 9_000_000);
    let now2 = env.ledger().timestamp();
    env.ledger().set_timestamp(now2 + 7_200 + 1);

    let id2 = fx
        .registry
        .propose_tier1(&Address::generate(&env), &asset2, &EventKind::Depeg, &1);

    let challenger = Address::generate(&env);
    let challenge_bond = 10_000_000_000i128;
    fx.usdc_admin_client.mint(&challenger, &challenge_bond);
    fx.registry
        .challenge(&challenger, &id2, &BytesN::from_array(&env, &[1u8; 32]));

    let record2 = fx.registry.event(&id2).unwrap();
    assert_eq!(record2.state, EventState::Escalated);
    assert_eq!(
        fx.staking.bond(&sylox_types::BondKey::EventChallenge(id2)),
        Some((challenger.clone(), challenge_bond))
    );

    fx.registry
        .rule(&id2, &true, &BytesN::from_array(&env, &[9u8; 32]));
    let record2 = fx.registry.event(&id2).unwrap();
    assert_eq!(record2.state, EventState::Declared);

    // The challenger's own bond was 100% forfeited (no second bonded
    // party for Tier 1, design note Section 7): it must reach
    // Treasury's Slashed bucket via a real deposit call, not a local
    // Staking credit (ADR-012).
    assert_eq!(
        fx.staking.bond(&sylox_types::BondKey::EventChallenge(id2)),
        None
    );
    assert_eq!(
        fx.treasury.balance(&TreasuryBucket::Slashed),
        challenge_bond
    );
    assert_eq!(fx.staking.claimable(&challenger), 0);

    // -- final balances --

    // Staking's own USDC balance: exactly the keeper's bond, nothing else.
    assert_eq!(fx.usdc_client.balance(&fx.staking.address), KEEPER_BOND);
    // Treasury's own USDC balance: exactly the Slashed bucket.
    assert_eq!(fx.usdc_client.balance(&fx.treasury.address), challenge_bond);

    let _ = fx.committee;
}
