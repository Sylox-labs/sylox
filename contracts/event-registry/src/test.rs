//! EventRegistry test suite. technical-doc.md Section 8 (all), 12.2,
//! 13, 14, 15, 21; design note `docs/design/event-registry.md`.

extern crate std;

mod integration;
mod property;

use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, Symbol};
use sylox_types::{
    AssetConfig, AssetEventStatus, CoverGate, EndpointStatus, EventDefinition, EventKind,
    EventState, IssuerFlags, Reference,
};

use crate::{Error, EventRegistry, EventRegistryClient};

// -- Minimal mocks for RiskOracle and Staking, for unit tests that
// don't need the real cross-contract behavior; the integration test
// module uses the real RiskOracle, Staking and Treasury throughout. --

/// Minimal mock `Staking`, only what `RiskOracle.post_signals` and
/// `EventRegistry`'s own bond calls need for a unit test. Every
/// keeper is active; bonds are recorded (so a test can assert a lock
/// happened) but move no real funds, matching `risk-oracle`'s own
/// `MockStaking` convention (not reused directly: that one is a
/// private `#[cfg(test)]` item inside `risk-oracle`'s own crate, not
/// reachable from here). The integration test module uses the real
/// `Staking` and `Treasury` instead.
#[contract]
struct MockStaking;

#[contractimpl]
impl MockStaking {
    pub fn is_active_keeper(_env: Env, _keeper: Address) -> bool {
        true
    }

    pub fn aggregate(_env: Env, _asset: Address, _epoch: u64) -> EndpointStatus {
        EndpointStatus::Up
    }

    pub fn settle_probes(_env: Env, _asset: Address, _epoch: u64) {}

    pub fn reward_keeper(_env: Env, _keeper: Address, _epochs: u32) -> i128 {
        0
    }

    pub fn lock_bond(
        env: Env,
        key: sylox_types::BondKey,
        owner: Address,
        amount: i128,
        subject: Option<Address>,
    ) {
        let _ = subject;
        env.storage()
            .temporary()
            .set(&StakingKey::Bond(key), &(owner, amount));
    }

    pub fn release_bond(env: Env, key: sylox_types::BondKey) {
        env.storage().temporary().remove(&StakingKey::Bond(key));
    }

    pub fn forfeit_bond(env: Env, key: sylox_types::BondKey, winner: Option<Address>) {
        let _ = winner;
        env.storage().temporary().remove(&StakingKey::Bond(key));
    }

    pub fn bond(env: Env, key: sylox_types::BondKey) -> Option<(Address, i128)> {
        env.storage().temporary().get(&StakingKey::Bond(key))
    }
}

#[derive(Clone)]
#[soroban_sdk::contracttype]
enum StakingKey {
    Bond(sylox_types::BondKey),
}

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
    client: EventRegistryClient<'a>,
    #[allow(dead_code)]
    contract_id: Address,
    governor_contract: Address,
    committee: Address,
    oracle: risk_oracle::RiskOracleClient<'a>,
    oracle_id: Address,
    staking: Address,
    staking_client: MockStakingClient<'a>,
    factory: Address,
    usdc: Address,
    keeper: Address,
}

fn setup(env: &Env) -> Fixture<'_> {
    env.mock_all_auths();

    let governor_contract = env.register(MockGovernor, ());
    let governor_client = MockGovernorClient::new(env, &governor_contract);
    let committee = Address::generate(env);
    governor_client.set_committee(&committee);

    let staking = env.register(MockStaking, ());
    let staking_client = MockStakingClient::new(env, &staking);

    let registry_id = env.register(EventRegistry, ());

    let oracle_id = env.register(risk_oracle::RiskOracle, ());
    let oracle = risk_oracle::RiskOracleClient::new(env, &oracle_id);
    oracle.initialize(&governor_contract, &registry_id, &staking);

    let factory = Address::generate(env);
    let usdc = Address::generate(env);

    let client = EventRegistryClient::new(env, &registry_id);
    client.initialize(&governor_contract, &oracle_id, &staking, &factory, &usdc);

    let keeper = Address::generate(env);

    Fixture {
        client,
        contract_id: registry_id,
        governor_contract,
        committee,
        oracle,
        oracle_id,
        staking,
        staking_client,
        factory,
        usdc,
        keeper,
    }
}

fn asset_config(env: &Env, asset: &Address, issuer: &Address, flags: IssuerFlags) -> AssetConfig {
    AssetConfig {
        asset: asset.clone(),
        issuer: issuer.clone(),
        reference: Reference::Usd,
        home_domain: soroban_sdk::String::from_str(env, "example.com"),
        amm_adapters: soroban_sdk::Vec::new(env),
        fx_adapter: None,
        min_liquidity: 100_000_000_000,
        issuer_flags: flags,
        enabled: true,
    }
}

fn depeg_definition(_env: &Env, asset: &Address) -> EventDefinition {
    EventDefinition {
        asset: asset.clone(),
        kind: EventKind::Depeg,
        version: 0, // ignored on input
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

fn issuer_freeze_definition(_env: &Env, asset: &Address) -> EventDefinition {
    EventDefinition {
        asset: asset.clone(),
        kind: EventKind::IssuerFreeze,
        version: 0,
        reference: Reference::Usd,
        depeg_threshold: 0,
        depeg_window_secs: 0,
        max_missing_epochs: 0,
        cure_threshold: 0,
        freeze_pct_bps: 500,
        auth_revocation_threshold: 3,
        mint_spike_bps: 0,
        halt_window_secs: 0,
        challenge_secs: 86_400,
        ruling_deadline_secs: 1_209_600,
    }
}

fn signal_set(
    env: &Env,
    keeper: &Address,
    epoch: u64,
    peg_ratio: i128,
    liquidity: i128,
) -> sylox_types::SignalSet {
    sylox_types::SignalSet {
        epoch,
        posted_at: 0,
        peg_ratio,
        peg_ratio_p10: peg_ratio,
        liquidity_2pct: liquidity,
        redemption_net: 0,
        supply: 10_000_000_000_000,
        supply_change_bps: 0,
        issuer_actions: sylox_types::IssuerActions::default(),
        endpoint: EndpointStatus::Unknown,
        inputs_hash: BytesN::from_array(env, &[7u8; 32]),
        poster: keeper.clone(),
    }
}

/// Posts epochs `[start_epoch, start_epoch + count)`, one `EPOCH_SECS`
/// apart (the steady-posting convention every other test in this
/// workspace uses), each with the given `peg_ratio`/`liquidity`.
/// Leaves the ledger timestamp at the last epoch's own close; callers
/// needing every epoch effectively Final must advance the clock by at
/// least `SIGNAL_DISPUTE_SECS` more themselves.
#[allow(clippy::too_many_arguments)]
fn post_run(
    env: &Env,
    oracle: &risk_oracle::RiskOracleClient,
    keeper: &Address,
    asset: &Address,
    start_epoch: u64,
    count: u64,
    peg_ratio: i128,
    liquidity: i128,
) {
    for i in 0..count {
        let epoch = start_epoch + i;
        env.ledger().set_timestamp((epoch + 1) * EPOCH_SECS);
        oracle.post_signals(
            keeper,
            asset,
            &signal_set(env, keeper, epoch, peg_ratio, liquidity),
        );
    }
}

/// Builds exactly the data a Depeg `propose_tier1` call needs to
/// pass: 168 healthy baseline epochs (epochs `0..168`, liquidity well
/// above `min_liquidity`), then 72 failing epochs (`168..240`, peg
/// ratio below `depeg_threshold`), then advances the clock past the
/// last epoch's own `pending_until` so every epoch is effectively
/// Final. Returns the epoch range `[168, 240)` is anchored to, i.e.
/// the epoch `propose_tier1`'s own window ends at (239).
fn post_failing_depeg_window(
    env: &Env,
    oracle: &risk_oracle::RiskOracleClient,
    keeper: &Address,
    asset: &Address,
) {
    post_run(
        env,
        oracle,
        keeper,
        asset,
        0,
        168,
        9_900_000,
        500_000_000_000,
    );
    post_run(
        env,
        oracle,
        keeper,
        asset,
        168,
        72,
        9_000_000,
        500_000_000_000,
    );
    let now = env.ledger().timestamp();
    env.ledger().set_timestamp(now + SIGNAL_DISPUTE_SECS + 1);
}

/// The same 168 epoch healthy baseline, but a Depeg window
/// (`168..240`) that PASSES (peg ratio at or above threshold), for
/// tests that need a registered, checkable Depeg definition without
/// an event actually triggering.
fn post_healthy_depeg_window(
    env: &Env,
    oracle: &risk_oracle::RiskOracleClient,
    keeper: &Address,
    asset: &Address,
) {
    post_run(
        env,
        oracle,
        keeper,
        asset,
        0,
        240,
        9_900_000,
        500_000_000_000,
    );
    let now = env.ledger().timestamp();
    env.ledger().set_timestamp(now + SIGNAL_DISPUTE_SECS + 1);
}

const EPOCH_SECS: u64 = 3_600;
const SIGNAL_DISPUTE_SECS: u64 = 7_200;
#[allow(dead_code)]
const WINDOW_SECS: u64 = 259_200;
#[allow(dead_code)]
const SIGNAL_DISPUTE_RULING_SECS: u64 = 604_800;

// -- initialize --

#[test]
fn initialize_succeeds_once() {
    let env = Env::default();
    let fx = setup(&env);
    let result = fx.client.try_initialize(
        &fx.governor_contract,
        &fx.oracle_id,
        &fx.staking,
        &fx.factory,
        &fx.usdc,
    );
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
}

#[test]
fn every_function_requiring_config_rejects_before_initialize() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(EventRegistry, ());
    let client = EventRegistryClient::new(&env, &contract_id);
    let asset = Address::generate(&env);

    let result = client.try_propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);
    assert_eq!(result, Err(Ok(Error::NotInitialized)));
}

// -- register_definition --

#[test]
fn register_definition_succeeds_for_depeg_and_assigns_version_1() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));

    let version = fx
        .client
        .register_definition(&depeg_definition(&env, &asset));
    assert_eq!(version, 1);
    assert_eq!(fx.client.current_version(&asset, &EventKind::Depeg), 1);
    let stored = fx.client.definition(&asset, &EventKind::Depeg, &1).unwrap();
    assert_eq!(stored.version, 1);
    assert_eq!(stored.depeg_threshold, 9_500_000);
}

#[test]
fn register_definition_requires_governor_auth() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));

    fx.client
        .register_definition(&depeg_definition(&env, &asset));
    assert_eq!(
        env.auths()[0].0,
        fx.governor_contract,
        "register_definition must check the governor's own auth"
    );
}

#[test]
fn register_definition_rejects_an_unknown_asset() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let result = fx
        .client
        .try_register_definition(&depeg_definition(&env, &asset));
    assert_eq!(result, Err(Ok(Error::InvalidDefinition)));
}

#[test]
fn register_definition_rejects_a_reference_mismatch() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));

    let mut def = depeg_definition(&env, &asset);
    def.reference = sylox_types::Reference::Fiat(
        Symbol::new(&env, "ARS"),
        sylox_types::FxRateSource::Official,
    );
    let result = fx.client.try_register_definition(&def);
    assert_eq!(result, Err(Ok(Error::InvalidDefinition)));
}

#[test]
fn register_definition_rejects_a_non_zero_parameter_unused_by_the_kind() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));

    let mut def = depeg_definition(&env, &asset);
    def.freeze_pct_bps = 100;
    let result = fx.client.try_register_definition(&def);
    assert_eq!(result, Err(Ok(Error::InvalidDefinition)));
}

#[test]
fn register_definition_rejects_a_window_plus_baseline_too_large_for_the_ring() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));

    let mut def = depeg_definition(&env, &asset);
    // 72 window epochs + 168 baseline epochs = 240 = RING_SLOTS already;
    // one more epoch of window tips it over.
    def.depeg_window_secs = (72 + 1) * 3_600;
    let result = fx.client.try_register_definition(&def);
    assert_eq!(result, Err(Ok(Error::InvalidDefinition)));
}

#[test]
fn register_definition_rejects_issuer_freeze_when_neither_flag_is_set() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));

    let result = fx
        .client
        .try_register_definition(&issuer_freeze_definition(&env, &asset));
    assert_eq!(result, Err(Ok(Error::FreezeImpossible)));
}

#[test]
fn register_definition_accepts_issuer_freeze_when_a_flag_is_set() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle.add_asset(&asset_config(
        &env,
        &asset,
        &issuer,
        IssuerFlags {
            auth_revocable: true,
            clawback_enabled: false,
        },
    ));

    let version = fx
        .client
        .register_definition(&issuer_freeze_definition(&env, &asset));
    assert_eq!(version, 1);
}

#[test]
fn register_definition_rejects_a_second_version_while_an_event_is_in_progress() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));

    let keeper = Address::generate(&env);
    post_failing_depeg_window(&env, &fx.oracle, &keeper, &asset);
    fx.client
        .propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);

    let result = fx
        .client
        .try_register_definition(&depeg_definition(&env, &asset));
    assert_eq!(result, Err(Ok(Error::EventInProgress)));
}

// -- propose_tier1: Depeg --

#[test]
fn propose_tier1_depeg_succeeds_on_a_failing_window() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));
    post_failing_depeg_window(&env, &fx.oracle, &fx.keeper, &asset);

    let caller = Address::generate(&env);
    let id = fx
        .client
        .propose_tier1(&caller, &asset, &EventKind::Depeg, &1);
    let record = fx.client.event(&id).unwrap();
    assert_eq!(record.state, EventState::Proposed);
    assert_eq!(record.kind, EventKind::Depeg);
    assert_eq!(record.def_version, 1);
    assert_eq!(record.bond, 0, "Tier 1 posts no proposer bond");
    assert_eq!(
        record.window_start,
        168 * 3_600,
        "window_start is the start of the window's own first epoch (168)"
    );
    assert!(matches!(
        fx.client.event_status(&asset, &EventKind::Depeg),
        AssetEventStatus::InProgress(found_id) if found_id == id
    ));
}

#[test]
fn propose_tier1_depeg_rejects_a_passing_window() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));
    post_healthy_depeg_window(&env, &fx.oracle, &fx.keeper, &asset);

    let result =
        fx.client
            .try_propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);
    assert_eq!(result, Err(Ok(Error::Tier1CheckFailed)));
}

#[test]
fn propose_tier1_depeg_tolerates_missing_epochs_up_to_max_missing_epochs() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));

    // 168 healthy baseline, then only 66 of the 72 window epochs
    // posted (6 missing, exactly `max_missing_epochs`), all failing.
    post_run(
        &env,
        &fx.oracle,
        &fx.keeper,
        &asset,
        0,
        168,
        9_900_000,
        500_000_000_000,
    );
    for i in 0..72u64 {
        let epoch = 168 + i;
        if i < 6 {
            continue; // leave the first 6 window epochs Empty
        }
        env.ledger().set_timestamp((epoch + 1) * EPOCH_SECS);
        fx.oracle.post_signals(
            &fx.keeper,
            &asset,
            &signal_set(&env, &fx.keeper, epoch, 9_000_000, 500_000_000_000),
        );
    }
    let now = env.ledger().timestamp();
    env.ledger().set_timestamp(now + SIGNAL_DISPUTE_SECS + 1);

    let id = fx
        .client
        .propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);
    assert!(fx.client.event(&id).is_some());
}

#[test]
fn propose_tier1_depeg_rejects_more_than_max_missing_epochs() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));

    post_run(
        &env,
        &fx.oracle,
        &fx.keeper,
        &asset,
        0,
        168,
        9_900_000,
        500_000_000_000,
    );
    for i in 0..72u64 {
        let epoch = 168 + i;
        if i < 7 {
            continue; // 7 missing, one more than max_missing_epochs
        }
        env.ledger().set_timestamp((epoch + 1) * EPOCH_SECS);
        fx.oracle.post_signals(
            &fx.keeper,
            &asset,
            &signal_set(&env, &fx.keeper, epoch, 9_000_000, 500_000_000_000),
        );
    }
    let now = env.ledger().timestamp();
    env.ledger().set_timestamp(now + SIGNAL_DISPUTE_SECS + 1);

    let result =
        fx.client
            .try_propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);
    assert_eq!(result, Err(Ok(Error::Tier1CheckFailed)));
}

#[test]
fn propose_tier1_depeg_rejects_a_liquidity_baseline_below_min_liquidity() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    // min_liquidity is 100_000_000_000 (see asset_config); post a
    // baseline just under it.
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));

    post_run(
        &env,
        &fx.oracle,
        &fx.keeper,
        &asset,
        0,
        168,
        9_900_000,
        50_000_000_000,
    );
    post_run(
        &env,
        &fx.oracle,
        &fx.keeper,
        &asset,
        168,
        72,
        9_000_000,
        500_000_000_000,
    );
    let now = env.ledger().timestamp();
    env.ledger().set_timestamp(now + SIGNAL_DISPUTE_SECS + 1);

    let result =
        fx.client
            .try_propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);
    assert_eq!(result, Err(Ok(Error::Tier1CheckFailed)));
}

/// Regression: `check_depeg`'s own `window_start_epoch` subtraction
/// must not underflow when the asset has posted far fewer epochs
/// than the 72 the window needs; it must fail closed, not panic or
/// wrap into a garbage epoch number.
#[test]
fn propose_tier1_depeg_fails_closed_with_not_enough_history_for_one_window() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));

    // Only 5 epochs ever posted, nowhere near the 72 the window needs.
    post_run(
        &env,
        &fx.oracle,
        &fx.keeper,
        &asset,
        0,
        5,
        9_000_000,
        500_000_000_000,
    );
    let now = env.ledger().timestamp();
    env.ledger().set_timestamp(now + SIGNAL_DISPUTE_SECS + 1);

    let result =
        fx.client
            .try_propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);
    assert_eq!(result, Err(Ok(Error::Tier1CheckFailed)));
}

#[test]
fn propose_tier1_rejects_an_unregistered_version() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let result =
        fx.client
            .try_propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);
    assert_eq!(result, Err(Ok(Error::UnknownDefinition)));
}

#[test]
fn propose_tier1_rejects_a_non_canonical_version_with_no_live_series() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));
    // Supersede version 1 with version 2 (no event in progress, no
    // live series to object either way in this build).
    post_healthy_depeg_window(&env, &fx.oracle, &fx.keeper, &asset);
    fx.client
        .register_definition(&depeg_definition(&env, &asset));
    assert_eq!(fx.client.current_version(&asset, &EventKind::Depeg), 2);

    let result =
        fx.client
            .try_propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);
    assert_eq!(
        result,
        Err(Ok(Error::VersionNotCovered)),
        "review item D3: a superseded, non-canonical version is not proposable \
         with no MarketFactory to confirm a live series still pins it"
    );
}

#[test]
fn propose_tier1_at_the_canonical_version_still_works_after_a_new_version_is_registered() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));
    post_healthy_depeg_window(&env, &fx.oracle, &fx.keeper, &asset);
    fx.client
        .register_definition(&depeg_definition(&env, &asset));

    post_run(
        &env,
        &fx.oracle,
        &fx.keeper,
        &asset,
        240,
        72,
        9_000_000,
        500_000_000_000,
    );
    let now = env.ledger().timestamp();
    env.ledger().set_timestamp(now + SIGNAL_DISPUTE_SECS + 1);

    let id = fx
        .client
        .propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &2);
    assert_eq!(fx.client.event(&id).unwrap().def_version, 2);
}

// -- propose_tier1: IssuerFreeze --

fn post_issuer_actions(
    env: &Env,
    oracle: &risk_oracle::RiskOracleClient,
    keeper: &Address,
    asset: &Address,
    clawback_amount: i128,
    auth_revocations: u32,
) {
    for epoch in 0..168u64 {
        env.ledger().set_timestamp((epoch + 1) * EPOCH_SECS);
        let mut set = signal_set(env, keeper, epoch, 10_000_000, 500_000_000_000);
        if epoch == 100 {
            set.issuer_actions = sylox_types::IssuerActions {
                clawbacks: 1,
                clawback_amount,
                auth_revocations,
                flag_changes: 0,
            };
        }
        oracle.post_signals(keeper, asset, &set);
    }
    let now = env.ledger().timestamp();
    env.ledger().set_timestamp(now + SIGNAL_DISPUTE_SECS + 1);
}

#[test]
fn propose_tier1_issuer_freeze_succeeds_on_a_clawback_above_threshold() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle.add_asset(&asset_config(
        &env,
        &asset,
        &issuer,
        IssuerFlags {
            auth_revocable: false,
            clawback_enabled: true,
        },
    ));
    fx.client
        .register_definition(&issuer_freeze_definition(&env, &asset));
    // freeze_pct_bps = 500 (5%); supply = 10_000_000_000_000; 5% is
    // 500_000_000_000.
    post_issuer_actions(&env, &fx.oracle, &fx.keeper, &asset, 600_000_000_000, 0);

    let id = fx.client.propose_tier1(
        &Address::generate(&env),
        &asset,
        &EventKind::IssuerFreeze,
        &1,
    );
    let record = fx.client.event(&id).unwrap();
    assert_eq!(record.window_start, 100 * 3_600);
}

#[test]
fn propose_tier1_issuer_freeze_rejects_below_both_thresholds() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle.add_asset(&asset_config(
        &env,
        &asset,
        &issuer,
        IssuerFlags {
            auth_revocable: false,
            clawback_enabled: true,
        },
    ));
    fx.client
        .register_definition(&issuer_freeze_definition(&env, &asset));
    post_issuer_actions(&env, &fx.oracle, &fx.keeper, &asset, 1_000_000, 1);

    let result = fx.client.try_propose_tier1(
        &Address::generate(&env),
        &asset,
        &EventKind::IssuerFreeze,
        &1,
    );
    assert_eq!(result, Err(Ok(Error::Tier1CheckFailed)));
}

#[test]
fn propose_tier1_issuer_freeze_succeeds_on_revocations_above_threshold() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle.add_asset(&asset_config(
        &env,
        &asset,
        &issuer,
        IssuerFlags {
            auth_revocable: true,
            clawback_enabled: false,
        },
    ));
    fx.client
        .register_definition(&issuer_freeze_definition(&env, &asset));
    // auth_revocation_threshold = 3; post 4.
    post_issuer_actions(&env, &fx.oracle, &fx.keeper, &asset, 0, 4);

    let id = fx.client.propose_tier1(
        &Address::generate(&env),
        &asset,
        &EventKind::IssuerFreeze,
        &1,
    );
    assert!(fx.client.event(&id).is_some());
}

#[test]
fn challenge_finalize_rule_and_resolve_timeout_reject_an_unknown_event_id() {
    let env = Env::default();
    let fx = setup(&env);
    let bogus_id = 999u64;

    assert_eq!(
        fx.client.try_challenge(
            &Address::generate(&env),
            &bogus_id,
            &BytesN::from_array(&env, &[1u8; 32])
        ),
        Err(Ok(Error::UnknownEvent))
    );
    assert_eq!(
        fx.client.try_finalize(&bogus_id),
        Err(Ok(Error::UnknownEvent))
    );
    assert_eq!(
        fx.client
            .try_rule(&bogus_id, &true, &BytesN::from_array(&env, &[2u8; 32])),
        Err(Ok(Error::UnknownEvent))
    );
    assert_eq!(
        fx.client.try_resolve_timeout(&bogus_id),
        Err(Ok(Error::UnknownEvent))
    );
}

// -- challenge --

#[test]
fn challenge_locks_a_bond_and_escalates_in_the_same_call() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));
    post_failing_depeg_window(&env, &fx.oracle, &fx.keeper, &asset);
    let id = fx
        .client
        .propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);

    let challenger = Address::generate(&env);
    fx.client
        .challenge(&challenger, &id, &BytesN::from_array(&env, &[1u8; 32]));

    let record = fx.client.event(&id).unwrap();
    assert_eq!(
        record.state,
        EventState::Escalated,
        "escalates in the same call; Challenged is never an observed storage value"
    );
    assert!(record.escalated_at.is_some());
    assert!(fx
        .staking_client
        .bond(&sylox_types::BondKey::EventChallenge(id))
        .is_some());
}

#[test]
fn challenge_rejects_after_the_challenge_window_closes() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));
    post_failing_depeg_window(&env, &fx.oracle, &fx.keeper, &asset);
    let id = fx
        .client
        .propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);

    let now = env.ledger().timestamp();
    env.ledger().set_timestamp(now + 86_400 + 1);
    let result = fx.client.try_challenge(
        &Address::generate(&env),
        &id,
        &BytesN::from_array(&env, &[1u8; 32]),
    );
    assert_eq!(result, Err(Ok(Error::ChallengeWindowClosed)));
}

#[test]
fn challenge_rejects_a_second_challenge() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));
    post_failing_depeg_window(&env, &fx.oracle, &fx.keeper, &asset);
    let id = fx
        .client
        .propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);
    fx.client.challenge(
        &Address::generate(&env),
        &id,
        &BytesN::from_array(&env, &[1u8; 32]),
    );

    let result = fx.client.try_challenge(
        &Address::generate(&env),
        &id,
        &BytesN::from_array(&env, &[2u8; 32]),
    );
    assert_eq!(result, Err(Ok(Error::WrongState)));
}

// -- finalize: unchallenged, and Depeg cure --

#[test]
fn finalize_rejects_before_the_challenge_window_elapses() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));
    post_failing_depeg_window(&env, &fx.oracle, &fx.keeper, &asset);
    let id = fx
        .client
        .propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);

    let result = fx.client.try_finalize(&id);
    assert_eq!(result, Err(Ok(Error::ChallengeWindowOpen)));
}

#[test]
fn finalize_declares_an_unchallenged_event_after_the_window() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));
    post_failing_depeg_window(&env, &fx.oracle, &fx.keeper, &asset);
    let id = fx
        .client
        .propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);

    // The cure window's own epochs (closing in [proposed_at,
    // proposed_at + challenge_secs)) are never posted; advance past
    // their own backfill window too, so they resolve to permanently
    // missing rather than merely not-ready, letting finalize decide.
    let now = env.ledger().timestamp();
    env.ledger()
        .set_timestamp(now + 86_400 + WINDOW_SECS + SIGNAL_DISPUTE_SECS + 1);
    fx.client.finalize(&id);

    let record = fx.client.event(&id).unwrap();
    assert_eq!(record.state, EventState::Declared);
    assert!(record.declared_at.is_some());
    assert!(matches!(
        fx.client.event_status(&asset, &EventKind::Depeg),
        AssetEventStatus::Declared(found_id, 1, _, _) if found_id == id
    ));
    assert!(fx.client.has_declared(&asset));
    assert!(
        !fx.client.in_progress(&asset),
        "Declared leaves the active count, the oracle flag must clear"
    );
}

/// Review items D1/R1/R2/R3: the cure window is the challenge window;
/// every one of its epochs must be Final and `>= cure_threshold`.
#[test]
fn finalize_cures_when_every_epoch_in_the_challenge_window_recovers() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));
    post_failing_depeg_window(&env, &fx.oracle, &fx.keeper, &asset);
    let id = fx
        .client
        .propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);
    let record = fx.client.event(&id).unwrap();

    // Post the cure window's own epochs (closing inside
    // [proposed_at, proposed_at + challenge_secs)) at or above
    // cure_threshold (9_800_000).
    let challenge_secs = 86_400u64;
    let first_cure_epoch = record.proposed_at / EPOCH_SECS;
    let last_cure_epoch = (record.proposed_at + challenge_secs) / EPOCH_SECS;
    for epoch in first_cure_epoch..last_cure_epoch {
        env.ledger().set_timestamp((epoch + 1) * EPOCH_SECS);
        fx.oracle.post_signals(
            &fx.keeper,
            &asset,
            &signal_set(&env, &fx.keeper, epoch, 9_900_000, 500_000_000_000),
        );
    }
    let now = record.proposed_at + challenge_secs;
    env.ledger()
        .set_timestamp(now.max(env.ledger().timestamp()) + SIGNAL_DISPUTE_SECS + 1);

    fx.client.finalize(&id);
    let record = fx.client.event(&id).unwrap();
    assert_eq!(record.state, EventState::Cured);
}

/// Review item R1: withholding attack. One permanently missing epoch
/// in the cure window, every other epoch above `cure_threshold`,
/// must still route to Declared, never Cured.
#[test]
fn finalize_never_cures_with_one_permanently_missing_cure_window_epoch() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));
    post_failing_depeg_window(&env, &fx.oracle, &fx.keeper, &asset);
    let id = fx
        .client
        .propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);
    let record = fx.client.event(&id).unwrap();

    let challenge_secs = 86_400u64;
    let first_cure_epoch = record.proposed_at / EPOCH_SECS;
    let last_cure_epoch = (record.proposed_at + challenge_secs) / EPOCH_SECS;
    for epoch in first_cure_epoch..last_cure_epoch {
        if epoch == first_cure_epoch {
            continue; // withheld: left permanently missing
        }
        env.ledger().set_timestamp((epoch + 1) * EPOCH_SECS);
        fx.oracle.post_signals(
            &fx.keeper,
            &asset,
            &signal_set(&env, &fx.keeper, epoch, 9_900_000, 500_000_000_000),
        );
    }
    // Past WINDOW_SECS from the withheld epoch's own close: it is now
    // permanently missing, not merely not-ready.
    let withheld_close = (first_cure_epoch + 1) * EPOCH_SECS;
    env.ledger()
        .set_timestamp(withheld_close + WINDOW_SECS + SIGNAL_DISPUTE_SECS + 1);

    fx.client.finalize(&id);
    let record = fx.client.event(&id).unwrap();
    assert_eq!(
        record.state,
        EventState::Declared,
        "review item R1: a permanently missing cure-window epoch must never cure, \
         even when every other epoch recovered"
    );
}

/// Review item R2: a late-posted, still-Pending epoch in the cure
/// window is not ready, never missing.
#[test]
fn finalize_returns_data_not_final_for_a_late_posted_still_pending_epoch() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));
    post_failing_depeg_window(&env, &fx.oracle, &fx.keeper, &asset);
    let id = fx
        .client
        .propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);
    let record = fx.client.event(&id).unwrap();

    let challenge_secs = 86_400u64;
    let first_cure_epoch = record.proposed_at / EPOCH_SECS;
    let last_cure_epoch = (record.proposed_at + challenge_secs) / EPOCH_SECS;
    let last_epoch = last_cure_epoch - 1;
    for epoch in first_cure_epoch..last_cure_epoch {
        if epoch == last_epoch {
            continue; // posted separately below, deliberately late
        }
        env.ledger().set_timestamp((epoch + 1) * EPOCH_SECS);
        fx.oracle.post_signals(
            &fx.keeper,
            &asset,
            &signal_set(&env, &fx.keeper, epoch, 9_900_000, 500_000_000_000),
        );
    }
    // Post the LAST cure-window epoch at the very last legal moment
    // (just before its own backfill window closes), so it is still
    // genuinely Pending, not yet Final, when challenge_secs elapses.
    let late_post_time = (last_epoch + 1) * EPOCH_SECS + WINDOW_SECS;
    env.ledger().set_timestamp(late_post_time);
    fx.oracle.post_signals(
        &fx.keeper,
        &asset,
        &signal_set(&env, &fx.keeper, last_epoch, 9_900_000, 500_000_000_000),
    );

    env.ledger()
        .set_timestamp((record.proposed_at + challenge_secs).max(late_post_time + 1));
    let result = fx.client.try_finalize(&id);
    assert_eq!(
        result,
        Err(Ok(Error::DataNotFinal)),
        "review item R2: a genuinely posted, still-Pending epoch must never be \
         classified as permanently missing merely because the clock has moved \
         past its own close plus the backfill window"
    );

    // Once pending_until passes, finalize decides.
    env.ledger()
        .set_timestamp(late_post_time + SIGNAL_DISPUTE_SECS + 1);
    fx.client.finalize(&id);
    assert_eq!(fx.client.event(&id).unwrap().state, EventState::Cured);
}

/// Review item R3: a Disputed epoch in the cure window is not ready
/// until the dispute resolves or times out (ADR-010).
#[test]
fn finalize_returns_data_not_final_while_a_cure_window_epoch_is_disputed() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));
    post_failing_depeg_window(&env, &fx.oracle, &fx.keeper, &asset);
    let id = fx
        .client
        .propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);
    let record = fx.client.event(&id).unwrap();

    let challenge_secs = 86_400u64;
    let first_cure_epoch = record.proposed_at / EPOCH_SECS;
    let last_cure_epoch = (record.proposed_at + challenge_secs) / EPOCH_SECS;
    let disputed_epoch = last_cure_epoch - 1;
    for epoch in first_cure_epoch..last_cure_epoch {
        env.ledger().set_timestamp((epoch + 1) * EPOCH_SECS);
        fx.oracle.post_signals(
            &fx.keeper,
            &asset,
            &signal_set(&env, &fx.keeper, epoch, 9_900_000, 500_000_000_000),
        );
    }
    // Dispute the last cure-window epoch while it is still Pending
    // (before its own pending_until), so it never becomes Final on
    // schedule.
    fx.oracle.dispute_signals(
        &Address::generate(&env),
        &asset,
        &disputed_epoch,
        &BytesN::from_array(&env, &[2u8; 32]),
    );

    env.ledger()
        .set_timestamp((record.proposed_at + challenge_secs).max(env.ledger().timestamp() + 1));
    assert_eq!(
        fx.client.try_finalize(&id),
        Err(Ok(Error::DataNotFinal)),
        "review item R3: a Disputed epoch is not ready until resolved or timed out"
    );

    // Time out the dispute (ADR-010's own silence-reads-as-keeper-wins
    // default); the epoch becomes Final and finalize can now decide.
    let now = env.ledger().timestamp();
    env.ledger()
        .set_timestamp(now + SIGNAL_DISPUTE_RULING_SECS + 1);
    fx.oracle
        .resolve_signal_dispute_timeout(&asset, &disputed_epoch);
    env.ledger().set_timestamp(env.ledger().timestamp() + 1);

    fx.client.finalize(&id);
    assert_eq!(
        fx.client.event(&id).unwrap().state,
        EventState::Cured,
        "once the dispute times out the epoch is Final and above cure_threshold"
    );
}

// -- rule --

#[test]
fn rule_declare_true_forfeits_the_challenger_bond_entirely() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));
    post_failing_depeg_window(&env, &fx.oracle, &fx.keeper, &asset);
    let id = fx
        .client
        .propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);
    let challenger = Address::generate(&env);
    fx.client
        .challenge(&challenger, &id, &BytesN::from_array(&env, &[1u8; 32]));

    fx.client
        .rule(&id, &true, &BytesN::from_array(&env, &[9u8; 32]));
    let record = fx.client.event(&id).unwrap();
    assert_eq!(record.state, EventState::Declared);
    assert!(
        fx.staking_client
            .bond(&sylox_types::BondKey::EventChallenge(id))
            .is_none(),
        "forfeit_bond clears the bond record"
    );
}

#[test]
fn rule_declare_false_releases_the_challenger_bond_in_full() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));
    post_failing_depeg_window(&env, &fx.oracle, &fx.keeper, &asset);
    let id = fx
        .client
        .propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);
    let challenger = Address::generate(&env);
    fx.client
        .challenge(&challenger, &id, &BytesN::from_array(&env, &[1u8; 32]));

    fx.client
        .rule(&id, &false, &BytesN::from_array(&env, &[9u8; 32]));
    let record = fx.client.event(&id).unwrap();
    assert_eq!(record.state, EventState::Rejected);
    assert!(fx
        .staking_client
        .bond(&sylox_types::BondKey::EventChallenge(id))
        .is_none());
    assert!(!fx.client.in_progress(&asset));
}

/// Review item E4: two kinds live on the same asset (Depeg,
/// IssuerFreeze), each its own event sharing one `ActiveCount`.
/// Rejecting one must not clear the oracle's `event_in_progress` flag
/// while the other is still live.
#[test]
fn two_kinds_live_rejecting_one_leaves_event_in_progress_true() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle.add_asset(&asset_config(
        &env,
        &asset,
        &issuer,
        IssuerFlags {
            auth_revocable: true,
            clawback_enabled: false,
        },
    ));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));
    fx.client
        .register_definition(&issuer_freeze_definition(&env, &asset));

    // One combined 240-epoch run: a healthy baseline (0..168), then a
    // failing Depeg window (168..240) with an auth-revocation spike
    // at epoch 200 (inside IssuerFreeze's own last-168-epoch window
    // too), so both kinds trigger off the same posted data without
    // double-posting any epoch.
    for epoch in 0u64..240 {
        env.ledger().set_timestamp((epoch + 1) * EPOCH_SECS);
        let peg_ratio = if epoch < 168 { 9_900_000 } else { 9_000_000 };
        let mut set = signal_set(&env, &fx.keeper, epoch, peg_ratio, 500_000_000_000);
        if epoch == 200 {
            set.issuer_actions = sylox_types::IssuerActions {
                clawbacks: 1,
                clawback_amount: 0,
                auth_revocations: 4,
                flag_changes: 0,
            };
        }
        fx.oracle.post_signals(&fx.keeper, &asset, &set);
    }
    let now = env.ledger().timestamp();
    env.ledger().set_timestamp(now + SIGNAL_DISPUTE_SECS + 1);

    let depeg_id = fx
        .client
        .propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);
    let freeze_id = fx.client.propose_tier1(
        &Address::generate(&env),
        &asset,
        &EventKind::IssuerFreeze,
        &1,
    );

    assert_eq!(fx.client.active_event_count(&asset), 2);
    assert!(fx.client.in_progress(&asset));
    assert!(fx.oracle.event_in_progress(&asset));

    // rule() requires Escalated; challenge the IssuerFreeze event
    // first, then have the committee reject it.
    fx.client.challenge(
        &Address::generate(&env),
        &freeze_id,
        &BytesN::from_array(&env, &[1u8; 32]),
    );
    fx.client
        .rule(&freeze_id, &false, &BytesN::from_array(&env, &[9u8; 32]));

    assert_eq!(fx.client.active_event_count(&asset), 1);
    assert!(
        fx.client.in_progress(&asset),
        "the Depeg event is still live"
    );
    assert!(
        fx.oracle.event_in_progress(&asset),
        "event_in_progress must stay true while any kind is still live"
    );

    fx.client.challenge(
        &Address::generate(&env),
        &depeg_id,
        &BytesN::from_array(&env, &[2u8; 32]),
    );
    fx.client
        .rule(&depeg_id, &false, &BytesN::from_array(&env, &[9u8; 32]));
    assert!(!fx.client.in_progress(&asset));
    assert!(!fx.oracle.event_in_progress(&asset));
}

#[test]
fn rule_rejects_after_the_ruling_deadline() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));
    post_failing_depeg_window(&env, &fx.oracle, &fx.keeper, &asset);
    let id = fx
        .client
        .propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);
    fx.client.challenge(
        &Address::generate(&env),
        &id,
        &BytesN::from_array(&env, &[1u8; 32]),
    );

    let now = env.ledger().timestamp();
    env.ledger().set_timestamp(now + 1_209_600 + 1);
    let result = fx
        .client
        .try_rule(&id, &true, &BytesN::from_array(&env, &[9u8; 32]));
    assert_eq!(result, Err(Ok(Error::RulingDeadlinePassed)));
}

#[test]
fn rule_requires_committee_auth() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));
    post_failing_depeg_window(&env, &fx.oracle, &fx.keeper, &asset);
    let id = fx
        .client
        .propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);
    fx.client.challenge(
        &Address::generate(&env),
        &id,
        &BytesN::from_array(&env, &[1u8; 32]),
    );

    fx.client
        .rule(&id, &true, &BytesN::from_array(&env, &[9u8; 32]));
    assert_eq!(env.auths()[0].0, fx.committee);
}

// -- resolve_timeout --

#[test]
fn resolve_timeout_declares_tier1_and_refunds_the_bond_in_full() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));
    post_failing_depeg_window(&env, &fx.oracle, &fx.keeper, &asset);
    let id = fx
        .client
        .propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);
    fx.client.challenge(
        &Address::generate(&env),
        &id,
        &BytesN::from_array(&env, &[1u8; 32]),
    );

    let now = env.ledger().timestamp();
    env.ledger().set_timestamp(now + 1_209_600 + 1);
    fx.client.resolve_timeout(&id);

    let record = fx.client.event(&id).unwrap();
    assert_eq!(
        record.state,
        EventState::Declared,
        "ADR-002: escalated Tier 1 defaults to Declared on timeout"
    );
    assert!(
        fx.staking_client
            .bond(&sylox_types::BondKey::EventChallenge(id))
            .is_none(),
        "the bond is refunded (removed from the mock's own bookkeeping), not forfeited"
    );
    assert_eq!(fx.client.committee_misses(&fx.committee), 1);
}

#[test]
fn resolve_timeout_rejects_before_the_deadline() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));
    post_failing_depeg_window(&env, &fx.oracle, &fx.keeper, &asset);
    let id = fx
        .client
        .propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);
    fx.client.challenge(
        &Address::generate(&env),
        &id,
        &BytesN::from_array(&env, &[1u8; 32]),
    );

    let result = fx.client.try_resolve_timeout(&id);
    assert_eq!(result, Err(Ok(Error::RulingDeadlineNotReached)));
}

// -- re-proposal after Cured/Rejected (review item D4) --

#[test]
fn re_proposal_on_unchanged_data_is_rejected() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));
    post_failing_depeg_window(&env, &fx.oracle, &fx.keeper, &asset);
    let id = fx
        .client
        .propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);
    fx.client.challenge(
        &Address::generate(&env),
        &id,
        &BytesN::from_array(&env, &[1u8; 32]),
    );
    fx.client
        .rule(&id, &false, &BytesN::from_array(&env, &[9u8; 32]));

    // Immediately re-propose: no new epoch has become Final, so the
    // freshly computed window is identical.
    let result =
        fx.client
            .try_propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);
    assert_eq!(result, Err(Ok(Error::EventInProgress)));
}

#[test]
fn re_proposal_once_window_start_moves_past_left_at_is_accepted() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));
    post_failing_depeg_window(&env, &fx.oracle, &fx.keeper, &asset);
    let id = fx
        .client
        .propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);
    fx.client.challenge(
        &Address::generate(&env),
        &id,
        &BytesN::from_array(&env, &[1u8; 32]),
    );
    fx.client
        .rule(&id, &false, &BytesN::from_array(&env, &[9u8; 32]));

    // Post well more than 72 more failing epochs: the new 72 epoch
    // window's own start (which only advances epoch-for-epoch as new
    // epochs post) must move strictly past `left_at`'s own
    // WALL-CLOCK time, not just past the old window's last epoch
    // number, and `left_at` sits partway into the gap between epoch
    // 240's close and epoch 241's, not exactly on an epoch boundary.
    post_run(
        &env,
        &fx.oracle,
        &fx.keeper,
        &asset,
        240,
        80,
        9_000_000,
        500_000_000_000,
    );
    let now = env.ledger().timestamp();
    env.ledger().set_timestamp(now + SIGNAL_DISPUTE_SECS + 1);

    let new_id = fx
        .client
        .propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);
    assert_ne!(new_id, id);
}

// -- reads --

#[test]
fn covers_checks_all_four_conditions() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));
    post_failing_depeg_window(&env, &fx.oracle, &fx.keeper, &asset);
    let id = fx
        .client
        .propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);
    let record = fx.client.event(&id).unwrap();

    assert!(fx
        .client
        .covers(&id, &1, &0, &(record.window_start + 259_200)));
    assert!(
        !fx.client
            .covers(&id, &2, &0, &(record.window_start + 259_200)),
        "wrong def_version"
    );
    assert!(
        !fx.client.covers(
            &id,
            &1,
            &(record.window_start + 1),
            &(record.window_start + 259_200)
        ),
        "window_start before series start"
    );
    assert!(
        !fx.client.covers(&id, &1, &0, &(record.window_start - 1)),
        "window_start after series expiry"
    );
}

#[test]
fn cover_gate_reports_event_in_progress_first() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    fx.client
        .register_definition(&depeg_definition(&env, &asset));
    post_failing_depeg_window(&env, &fx.oracle, &fx.keeper, &asset);
    fx.client
        .propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);

    assert_eq!(fx.client.cover_gate(&asset), CoverGate::EventInProgress);
}

#[test]
fn cover_gate_reports_recent_depeg() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    // No definition registered: the Section 23 default window/threshold applies.
    post_run(
        &env,
        &fx.oracle,
        &fx.keeper,
        &asset,
        0,
        1,
        9_000_000,
        500_000_000_000,
    );
    assert_eq!(fx.client.cover_gate(&asset), CoverGate::RecentDepeg);
}

#[test]
fn cover_gate_clear_with_no_activity() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));
    assert_eq!(fx.client.cover_gate(&asset), CoverGate::Clear);
}
