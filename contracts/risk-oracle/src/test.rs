extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, BytesN, Env, IntoVal,
};
use sylox_types::{EndpointStatus, IssuerActions, Reference, SignalSet, SlotState};

use crate::{storage::RING_SLOTS, Error, RiskOracle, RiskOracleClient};

fn setup(env: &Env) -> (RiskOracleClient<'_>, Address, Address, Address) {
    env.mock_all_auths();
    let contract_id = env.register(RiskOracle, ());
    let client = RiskOracleClient::new(env, &contract_id);
    let governor = Address::generate(env);
    let registry = Address::generate(env);
    let staking = Address::generate(env);
    client.initialize(&governor, &registry, &staking);
    (client, governor, registry, staking)
}

fn asset_config(env: &Env, asset: &Address, issuer: &Address) -> sylox_types::AssetConfig {
    sylox_types::AssetConfig {
        asset: asset.clone(),
        issuer: issuer.clone(),
        reference: Reference::Usd,
        home_domain: soroban_sdk::String::from_str(env, "example.com"),
        amm_adapters: soroban_sdk::Vec::new(env),
        fx_adapter: None,
        min_liquidity: 100_000_000_000,
        issuer_flags: sylox_types::IssuerFlags::default(),
        enabled: true,
    }
}

fn signal_set(env: &Env, epoch: u64, peg_ratio: i128) -> SignalSet {
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
        endpoint: EndpointStatus::Up,
        inputs_hash: BytesN::from_array(env, &[1u8; 32]),
        poster: Address::generate(env),
    }
}

#[test]
fn initialize_once_then_rejects_a_second_call() {
    let env = Env::default();
    let (client, governor, registry, staking) = setup(&env);
    let result = client.try_initialize(&governor, &registry, &staking);
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
}

#[test]
fn add_asset_requires_governor_auth() {
    let env = Env::default();
    let (client, governor, _registry, _staking) = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    let cfg = asset_config(&env, &asset, &issuer);

    client.add_asset(&cfg);
    assert_eq!(
        env.auths(),
        [(
            governor.clone(),
            soroban_sdk::testutils::AuthorizedInvocation {
                function: soroban_sdk::testutils::AuthorizedFunction::Contract((
                    client.address.clone(),
                    soroban_sdk::symbol_short!("add_asset"),
                    (cfg.clone(),).into_val(&env),
                )),
                sub_invocations: std::vec![],
            }
        )]
    );
    assert_eq!(client.asset_config(&asset), Some(cfg));
}

#[test]
fn post_signals_requires_keeper_auth() {
    let env = Env::default();
    let (client, _governor, _registry, _staking) = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    client.add_asset(&asset_config(&env, &asset, &issuer));

    env.ledger().set_timestamp(10 * 3_600);
    let keeper = Address::generate(&env);
    let s = signal_set(&env, 5, 9_900_000);
    client.post_signals(&keeper, &asset, &s);

    assert_eq!(
        env.auths(),
        [(
            keeper.clone(),
            soroban_sdk::testutils::AuthorizedInvocation {
                function: soroban_sdk::testutils::AuthorizedFunction::Contract((
                    client.address.clone(),
                    soroban_sdk::Symbol::new(&env, "post_signals"),
                    (keeper.clone(), asset.clone(), s.clone()).into_val(&env),
                )),
                sub_invocations: std::vec![],
            }
        )]
    );
}

#[test]
fn post_signals_writes_signals_and_ring_slot() {
    let env = Env::default();
    let (client, _governor, _registry, _staking) = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    client.add_asset(&asset_config(&env, &asset, &issuer));

    env.ledger().set_timestamp(10 * 3_600);
    let keeper = Address::generate(&env);
    let s = signal_set(&env, 5, 9_900_000);
    client.post_signals(&keeper, &asset, &s);

    let stored = client.signals(&asset, &5).expect("signals stored");
    assert_eq!(stored.peg_ratio, 9_900_000);
    assert_eq!(stored.poster, keeper);
    // The keeper's endpoint value is always discarded in Phase 1 (Staking
    // does not exist yet to supply a real aggregate); Up must not survive.
    assert_eq!(stored.endpoint, EndpointStatus::Unknown);

    let ring = client.ring(&asset);
    assert_eq!(ring.len(), RING_SLOTS);
    let slot = ring.get(5).unwrap();
    assert_eq!(slot.epoch, 5);
    assert_eq!(slot.state, SlotState::Pending);
    assert_eq!(slot.peg_ratio, 9_900_000);
}

#[test]
fn post_signals_rejects_unknown_asset() {
    let env = Env::default();
    let (client, _governor, _registry, _staking) = setup(&env);
    env.ledger().set_timestamp(10 * 3_600);
    let keeper = Address::generate(&env);
    let asset = Address::generate(&env);
    let s = signal_set(&env, 5, 9_900_000);
    let result = client.try_post_signals(&keeper, &asset, &s);
    assert_eq!(result, Err(Ok(Error::UnknownAsset)));
}

#[test]
fn post_signals_rejects_an_epoch_not_yet_closed() {
    let env = Env::default();
    let (client, _governor, _registry, _staking) = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    client.add_asset(&asset_config(&env, &asset, &issuer));

    // At timestamp 3_600 the current epoch is 1; epoch 1 has not closed yet.
    env.ledger().set_timestamp(3_600);
    let keeper = Address::generate(&env);
    let s = signal_set(&env, 1, 9_900_000);
    let result = client.try_post_signals(&keeper, &asset, &s);
    assert_eq!(result, Err(Ok(Error::WrongEpoch)));
}

#[test]
fn post_signals_rejects_an_epoch_older_than_window_secs() {
    let env = Env::default();
    let (client, _governor, _registry, _staking) = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    client.add_asset(&asset_config(&env, &asset, &issuer));

    // window_secs = 259_200 (72h) = 72 epochs at the default epoch_secs.
    // Epoch 0 closes at 3_600; posting far past the window must fail.
    env.ledger().set_timestamp(3_600 + 259_200 + 3_600);
    let keeper = Address::generate(&env);
    let s = signal_set(&env, 0, 9_900_000);
    let result = client.try_post_signals(&keeper, &asset, &s);
    assert_eq!(result, Err(Ok(Error::WrongEpoch)));
}

#[test]
fn post_signals_rejects_a_duplicate_posting_for_the_same_epoch() {
    let env = Env::default();
    let (client, _governor, _registry, _staking) = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    client.add_asset(&asset_config(&env, &asset, &issuer));

    env.ledger().set_timestamp(10 * 3_600);
    let keeper = Address::generate(&env);
    client.post_signals(&keeper, &asset, &signal_set(&env, 5, 9_900_000));
    let result = client.try_post_signals(&keeper, &asset, &signal_set(&env, 5, 9_800_000));
    assert_eq!(result, Err(Ok(Error::EpochAlreadyPosted)));
}

#[test]
fn post_signals_rejects_peg_ratio_outside_sanity_bounds() {
    let env = Env::default();
    let (client, _governor, _registry, _staking) = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    client.add_asset(&asset_config(&env, &asset, &issuer));

    env.ledger().set_timestamp(10 * 3_600);
    let keeper = Address::generate(&env);
    let mut s = signal_set(&env, 5, 9_900_000);
    s.peg_ratio = 2 * sylox_types::SCALE + 1;
    let result = client.try_post_signals(&keeper, &asset, &s);
    assert_eq!(result, Err(Ok(Error::SanityBoundFailed)));
}

#[test]
fn post_signals_rejects_negative_liquidity() {
    let env = Env::default();
    let (client, _governor, _registry, _staking) = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    client.add_asset(&asset_config(&env, &asset, &issuer));

    env.ledger().set_timestamp(10 * 3_600);
    let keeper = Address::generate(&env);
    let mut s = signal_set(&env, 5, 9_900_000);
    s.liquidity_2pct = -1;
    let result = client.try_post_signals(&keeper, &asset, &s);
    assert_eq!(result, Err(Ok(Error::SanityBoundFailed)));
}

#[test]
fn ring_wraps_at_ring_slots() {
    let env = Env::default();
    let (client, _governor, _registry, _staking) = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    client.add_asset(&asset_config(&env, &asset, &issuer));

    // Post an epoch far enough in the past (but inside window_secs of a
    // later "now") that its ring index collides with a fresh asset's
    // epoch 0 slot, and confirm the slot holds the newer write.
    let epoch_a: u64 = 1;
    let epoch_b: u64 = epoch_a + RING_SLOTS as u64;

    env.ledger().set_timestamp((epoch_a + 1) * 3_600);
    let keeper = Address::generate(&env);
    client.post_signals(&keeper, &asset, &signal_set(&env, epoch_a, 9_900_000));

    env.ledger().set_timestamp((epoch_b + 1) * 3_600);
    client.post_signals(&keeper, &asset, &signal_set(&env, epoch_b, 9_500_000));

    let ring = client.ring(&asset);
    let index = (epoch_a as u32) % RING_SLOTS;
    let slot = ring.get(index).unwrap();
    assert_eq!(slot.epoch, epoch_b);
    assert_eq!(slot.peg_ratio, 9_500_000);
}
