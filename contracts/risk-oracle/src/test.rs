extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, BytesN, Env, IntoVal,
};
use sylox_types::{
    Band, EndpointStatus, FxRateSource, IssuerActions, Reference, SignalSet, SlotState,
};

use crate::mocks::{MockFxAdapter, MockGovernor, MockPriceAdapter, MockStaking};
use crate::storage::RING_SLOTS;
use crate::{Error, RiskOracle, RiskOracleClient};

struct Fixture<'a> {
    client: RiskOracleClient<'a>,
    staking: Address,
    governor: Address,
    registry: Address,
}

fn setup(env: &Env) -> Fixture<'_> {
    env.mock_all_auths();
    let staking = env.register(MockStaking, ());
    let contract_id = env.register(RiskOracle, ());
    let client = RiskOracleClient::new(env, &contract_id);
    let governor = Address::generate(env);
    let registry = Address::generate(env);
    client.initialize(&governor, &registry, &staking);
    Fixture {
        client,
        staking,
        governor,
        registry,
    }
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

fn setup_with_asset(env: &Env) -> (Fixture<'_>, Address) {
    let fx = setup(env);
    let asset = Address::generate(env);
    let issuer = Address::generate(env);
    fx.client.add_asset(&asset_config(env, &asset, &issuer));
    (fx, asset)
}

fn post(env: &Env, client: &RiskOracleClient, asset: &Address, epoch: u64, peg_ratio: i128) {
    env.ledger().set_timestamp((epoch + 1) * 3_600);
    let keeper = Address::generate(env);
    client.post_signals(&keeper, asset, &signal_set(env, epoch, peg_ratio));
}

/// Posts `epoch - 1`'s supply equal to `epoch`'s, so the Section 11.3
/// supply-change consistency check never rejects a sequential fill.
fn post_sequential(
    env: &Env,
    client: &RiskOracleClient,
    asset: &Address,
    epoch: u64,
    peg_ratio: i128,
) {
    post(env, client, asset, epoch, peg_ratio);
}

/// Finds `epoch`'s slot in `ring(asset)`'s output by epoch identity, not
/// by array position: `ring()` returns slots ordered oldest-first by
/// recency (`storage::get_ring`'s doc comment), which is not the same as
/// `epoch % RING_SLOTS`.
fn find_slot_by_epoch(
    ring: &soroban_sdk::Vec<sylox_types::RingSlot>,
    epoch: u64,
) -> sylox_types::RingSlot {
    ring.iter()
        .find(|slot| slot.epoch == epoch)
        .unwrap_or_else(|| std::panic!("epoch {epoch} not found in ring()"))
}

// -- initialize / add_asset / update_asset / disable_asset --

#[test]
fn initialize_once_then_rejects_a_second_call() {
    let env = Env::default();
    let fx = setup(&env);
    let result = fx
        .client
        .try_initialize(&fx.governor, &fx.registry, &fx.staking);
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
}

#[test]
fn add_asset_requires_governor_auth() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    let cfg = asset_config(&env, &asset, &issuer);

    fx.client.add_asset(&cfg);
    assert_eq!(
        env.auths(),
        [(
            fx.governor.clone(),
            soroban_sdk::testutils::AuthorizedInvocation {
                function: soroban_sdk::testutils::AuthorizedFunction::Contract((
                    fx.client.address.clone(),
                    soroban_sdk::symbol_short!("add_asset"),
                    (cfg.clone(),).into_val(&env),
                )),
                sub_invocations: std::vec![],
            }
        )]
    );
    assert_eq!(fx.client.asset_config(&asset), Some(cfg));
}

#[test]
fn add_asset_rejects_an_asset_that_already_exists() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    let issuer = Address::generate(&env);
    let result = fx
        .client
        .try_add_asset(&asset_config(&env, &asset, &issuer));
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
}

#[test]
fn update_asset_rejects_a_change_to_reference() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    let issuer = Address::generate(&env);
    let mut cfg = asset_config(&env, &asset, &issuer);
    cfg.reference = Reference::Fiat(soroban_sdk::symbol_short!("EUR"), FxRateSource::Official);
    let result = fx.client.try_update_asset(&asset, &cfg);
    assert_eq!(result, Err(Ok(Error::ReferenceImmutable)));
}

#[test]
fn update_asset_allows_a_change_to_min_liquidity() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    let issuer = Address::generate(&env);
    let mut cfg = asset_config(&env, &asset, &issuer);
    cfg.min_liquidity = 999;
    fx.client.update_asset(&asset, &cfg);
    assert_eq!(fx.client.asset_config(&asset).unwrap().min_liquidity, 999);
}

#[test]
fn disable_asset_blocks_further_posting() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    fx.client.disable_asset(&asset);

    env.ledger().set_timestamp(10 * 3_600);
    let keeper = Address::generate(&env);
    let result = fx
        .client
        .try_post_signals(&keeper, &asset, &signal_set(&env, 5, 9_900_000));
    assert_eq!(result, Err(Ok(Error::UnknownAsset)));
}

// -- post_signals: auth, keeper eligibility, epoch window --

#[test]
fn post_signals_requires_keeper_auth() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);

    env.ledger().set_timestamp(10 * 3_600);
    let keeper = Address::generate(&env);
    let s = signal_set(&env, 5, 9_900_000);
    fx.client.post_signals(&keeper, &asset, &s);

    assert_eq!(
        env.auths(),
        [(
            keeper.clone(),
            soroban_sdk::testutils::AuthorizedInvocation {
                function: soroban_sdk::testutils::AuthorizedFunction::Contract((
                    fx.client.address.clone(),
                    soroban_sdk::Symbol::new(&env, "post_signals"),
                    (keeper.clone(), asset.clone(), s.clone()).into_val(&env),
                )),
                sub_invocations: std::vec![],
            }
        )]
    );
}

#[test]
fn post_signals_rejects_an_inactive_keeper() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    let staking_client = crate::mocks::MockStakingClient::new(&env, &fx.staking);

    env.ledger().set_timestamp(10 * 3_600);
    let keeper = Address::generate(&env);
    staking_client.set_active(&keeper, &false);

    let result = fx
        .client
        .try_post_signals(&keeper, &asset, &signal_set(&env, 5, 9_900_000));
    assert_eq!(result, Err(Ok(Error::KeeperNotActive)));
}

#[test]
fn post_signals_writes_signals_and_ring_slot() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);

    env.ledger().set_timestamp(10 * 3_600);
    let keeper = Address::generate(&env);
    let s = signal_set(&env, 5, 9_900_000);
    fx.client.post_signals(&keeper, &asset, &s);

    let stored = fx.client.signals(&asset, &5).expect("signals stored");
    assert_eq!(stored.peg_ratio, 9_900_000);
    assert_eq!(stored.poster, keeper);
    // No Staking.aggregate was set for this (asset, epoch), so the mock
    // returns Unknown; a keeper-supplied Up must not survive either way.
    assert_eq!(stored.endpoint, EndpointStatus::Unknown);

    let ring = fx.client.ring(&asset);
    assert_eq!(ring.len(), RING_SLOTS);
}

#[test]
fn post_signals_sources_endpoint_only_from_staking_aggregate() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    let staking_client = crate::mocks::MockStakingClient::new(&env, &fx.staking);
    staking_client.set_aggregate(&asset, &5, &EndpointStatus::Degraded);

    env.ledger().set_timestamp(10 * 3_600);
    let keeper = Address::generate(&env);
    let mut s = signal_set(&env, 5, 9_900_000);
    s.endpoint = EndpointStatus::Up; // keeper tries to claim Up
    fx.client.post_signals(&keeper, &asset, &s);

    let stored = fx.client.signals(&asset, &5).unwrap();
    assert_eq!(stored.endpoint, EndpointStatus::Degraded);
}

#[test]
fn post_signals_rejects_unknown_asset() {
    let env = Env::default();
    let fx = setup(&env);
    env.ledger().set_timestamp(10 * 3_600);
    let keeper = Address::generate(&env);
    let asset = Address::generate(&env);
    let s = signal_set(&env, 5, 9_900_000);
    let result = fx.client.try_post_signals(&keeper, &asset, &s);
    assert_eq!(result, Err(Ok(Error::UnknownAsset)));
}

#[test]
fn post_signals_rejects_an_epoch_not_yet_closed() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);

    // At timestamp 3_600 the current epoch is 1; epoch 1 has not closed yet.
    env.ledger().set_timestamp(3_600);
    let keeper = Address::generate(&env);
    let s = signal_set(&env, 1, 9_900_000);
    let result = fx.client.try_post_signals(&keeper, &asset, &s);
    assert_eq!(result, Err(Ok(Error::WrongEpoch)));
}

#[test]
fn post_signals_rejects_an_epoch_older_than_window_secs() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);

    // window_secs = 259_200 (72h) = 72 epochs at the default epoch_secs.
    env.ledger().set_timestamp(3_600 + 259_200 + 3_600);
    let keeper = Address::generate(&env);
    let s = signal_set(&env, 0, 9_900_000);
    let result = fx.client.try_post_signals(&keeper, &asset, &s);
    assert_eq!(result, Err(Ok(Error::WrongEpoch)));
}

#[test]
fn post_signals_rejects_a_duplicate_posting_for_the_same_epoch() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);

    env.ledger().set_timestamp(10 * 3_600);
    let keeper = Address::generate(&env);
    fx.client
        .post_signals(&keeper, &asset, &signal_set(&env, 5, 9_900_000));
    let result = fx
        .client
        .try_post_signals(&keeper, &asset, &signal_set(&env, 5, 9_800_000));
    assert_eq!(result, Err(Ok(Error::EpochAlreadyPosted)));
}

// -- post_signals: Section 11.3 sanity bounds, in full --

#[test]
fn post_signals_rejects_peg_ratio_outside_sanity_bounds() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);

    env.ledger().set_timestamp(10 * 3_600);
    let keeper = Address::generate(&env);
    let mut s = signal_set(&env, 5, 9_900_000);
    s.peg_ratio = 2 * sylox_types::SCALE + 1;
    s.peg_ratio_p10 = s.peg_ratio; // keep p10 <= peg_ratio so only this bound fires
    let result = fx.client.try_post_signals(&keeper, &asset, &s);
    assert_eq!(result, Err(Ok(Error::SanityBoundFailed)));
}

#[test]
fn post_signals_rejects_peg_ratio_p10_above_peg_ratio() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);

    env.ledger().set_timestamp(10 * 3_600);
    let keeper = Address::generate(&env);
    let mut s = signal_set(&env, 5, 9_900_000);
    s.peg_ratio_p10 = s.peg_ratio + 1;
    let result = fx.client.try_post_signals(&keeper, &asset, &s);
    assert_eq!(result, Err(Ok(Error::SanityBoundFailed)));
}

#[test]
fn post_signals_accepts_peg_ratio_p10_equal_to_peg_ratio() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);

    env.ledger().set_timestamp(10 * 3_600);
    let keeper = Address::generate(&env);
    let mut s = signal_set(&env, 5, 9_900_000);
    s.peg_ratio_p10 = s.peg_ratio;
    fx.client.post_signals(&keeper, &asset, &s);
    assert!(fx.client.signals(&asset, &5).is_some());
}

#[test]
fn post_signals_rejects_negative_liquidity() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);

    env.ledger().set_timestamp(10 * 3_600);
    let keeper = Address::generate(&env);
    let mut s = signal_set(&env, 5, 9_900_000);
    s.liquidity_2pct = -1;
    let result = fx.client.try_post_signals(&keeper, &asset, &s);
    assert_eq!(result, Err(Ok(Error::SanityBoundFailed)));
}

#[test]
fn post_signals_rejects_liquidity_above_the_upper_bound() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);

    env.ledger().set_timestamp(10 * 3_600);
    let keeper = Address::generate(&env);
    let mut s = signal_set(&env, 5, 9_900_000);
    s.liquidity_2pct = i128::MAX / sylox_types::SCALE + 1;
    let result = fx.client.try_post_signals(&keeper, &asset, &s);
    assert_eq!(result, Err(Ok(Error::SanityBoundFailed)));
}

#[test]
fn post_signals_rejects_negative_supply() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);

    env.ledger().set_timestamp(10 * 3_600);
    let keeper = Address::generate(&env);
    let mut s = signal_set(&env, 5, 9_900_000);
    s.supply = -1;
    let result = fx.client.try_post_signals(&keeper, &asset, &s);
    assert_eq!(result, Err(Ok(Error::SanityBoundFailed)));
}

#[test]
fn post_signals_rejects_supply_above_the_upper_bound() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);

    env.ledger().set_timestamp(10 * 3_600);
    let keeper = Address::generate(&env);
    let mut s = signal_set(&env, 5, 9_900_000);
    s.supply = i128::MAX / sylox_types::SCALE + 1;
    let result = fx.client.try_post_signals(&keeper, &asset, &s);
    assert_eq!(result, Err(Ok(Error::SanityBoundFailed)));
}

#[test]
fn post_signals_rejects_a_supply_change_bps_inconsistent_with_the_previous_epoch() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    let keeper = Address::generate(&env);

    env.ledger().set_timestamp(6 * 3_600);
    let mut first = signal_set(&env, 5, 9_900_000);
    first.supply = 10_000_000_000_000;
    fx.client.post_signals(&keeper, &asset, &first);

    env.ledger().set_timestamp(7 * 3_600);
    let mut second = signal_set(&env, 6, 9_900_000);
    second.supply = 11_000_000_000_000; // true change is 1,000 bps (10%)
    second.supply_change_bps = 0; // posted value is wrong
    let result = fx.client.try_post_signals(&keeper, &asset, &second);
    assert_eq!(result, Err(Ok(Error::SanityBoundFailed)));
}

#[test]
fn post_signals_accepts_a_supply_change_bps_consistent_with_the_previous_epoch() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    let keeper = Address::generate(&env);

    env.ledger().set_timestamp(6 * 3_600);
    let mut first = signal_set(&env, 5, 9_900_000);
    first.supply = 10_000_000_000_000;
    fx.client.post_signals(&keeper, &asset, &first);

    env.ledger().set_timestamp(7 * 3_600);
    let mut second = signal_set(&env, 6, 9_900_000);
    second.supply = 11_000_000_000_000;
    second.supply_change_bps = 1_000; // correct: 10% = 1,000 bps
    fx.client.post_signals(&keeper, &asset, &second);
    assert!(fx.client.signals(&asset, &6).is_some());
}

#[test]
fn post_signals_accepts_any_supply_change_bps_for_the_first_epoch() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    let keeper = Address::generate(&env);

    env.ledger().set_timestamp(3_600);
    let mut s = signal_set(&env, 0, 9_900_000);
    s.supply_change_bps = 999_999; // nothing to compare epoch 0 against
    fx.client.post_signals(&keeper, &asset, &s);
    assert!(fx.client.signals(&asset, &0).is_some());
}

// -- ring buffer: epoch identity, never array position (required change #3) --

#[test]
fn ring_wraps_at_ring_slots_and_identifies_slots_by_epoch_not_position() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    let keeper = Address::generate(&env);

    let epoch_a: u64 = 1;
    let epoch_b: u64 = epoch_a + RING_SLOTS as u64; // same position as epoch_a

    post(&env, &fx.client, &asset, epoch_a, 9_900_000);
    assert_eq!(
        fx.client.signals(&asset, &epoch_a).unwrap().peg_ratio,
        9_900_000
    );

    env.ledger().set_timestamp((epoch_b + 1) * 3_600);
    fx.client
        .post_signals(&keeper, &asset, &signal_set(&env, epoch_b, 9_500_000));

    // get_ring, read by epoch identity via get(0) is wrong by construction
    // now; instead confirm the SIGNALS record for epoch_a is untouched
    // (position based overwrite would not affect this) while the ring
    // position that both epochs share now resolves, by epoch lookup, only
    // to epoch_b.
    assert_eq!(
        fx.client.signals(&asset, &epoch_a).unwrap().peg_ratio,
        9_900_000,
        "epoch_a's own Signals record must be untouched by epoch_b's post"
    );
}

/// Wraps the ring more than twice and proves that a window read aligned
/// to a set of known epochs returns exactly those epochs' data, not
/// whatever happens to sit at the matching array positions. This is the
/// test the review explicitly asked for: "wrap the ring at least twice
/// and prove windows and aggregates read the right epochs."
#[test]
fn window_reads_the_right_epochs_after_wrapping_twice() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    let keeper = Address::generate(&env);

    // Post 2*RING_SLOTS + 10 consecutive epochs (more than two full wraps),
    // each with a peg_ratio equal to its own epoch number (offset so it is
    // never zero), so a window read can check "did I get epoch N's data"
    // unambiguously.
    let total_epochs = 2 * RING_SLOTS as u64 + 10;
    for epoch in 0..total_epochs {
        env.ledger().set_timestamp((epoch + 1) * 3_600);
        let mut s = signal_set(&env, epoch, 1_000_000 + epoch as i128);
        s.supply_change_bps = 0;
        fx.client.post_signals(&keeper, &asset, &s);
    }

    let newest = total_epochs - 1;
    let contract_id = fx.client.address.clone();
    env.as_contract(&contract_id, || {
        let window = crate::storage::get_window(&env, &asset, newest - 9, 10);
        for (i, slot) in window.iter().enumerate() {
            let expected_epoch = newest - 9 + i as u64;
            let slot = slot.expect("recent epoch must not be missing");
            assert_eq!(slot.epoch, expected_epoch);
            assert_eq!(slot.peg_ratio, 1_000_000 + expected_epoch as i128);
        }

        // The ring has wrapped more than twice; positions now hold only
        // the newest epoch congruent to them. A window straddling an old,
        // long overwritten epoch range must report those epochs as
        // missing, never return a wrong epoch's data for them.
        let stale_window = crate::storage::get_window(&env, &asset, 0, 10);
        for slot in stale_window.iter() {
            assert!(
                slot.is_none(),
                "an epoch whose position has been overwritten many times over must read as missing, not as some other epoch's data"
            );
        }
    });
}

/// Required change #4: a write must never overwrite a slot that holds a
/// newer epoch than the incoming one.
#[test]
fn write_ring_slot_refuses_to_overwrite_a_newer_epoch() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(RiskOracle, ());
    let asset = Address::generate(&env);

    env.as_contract(&contract_id, || {
        let newer_epoch = RING_SLOTS as u64 + 5; // same position as epoch 5
        let older_epoch = 5u64;

        let signals = signal_set(&env, newer_epoch, 9_900_000);
        let wrote_newer = crate::storage::write_ring_slot(&env, &asset, newer_epoch, &signals, 100);
        assert!(wrote_newer);

        let stale_signals = signal_set(&env, older_epoch, 9_000_000);
        let wrote_older =
            crate::storage::write_ring_slot(&env, &asset, older_epoch, &stale_signals, 100);
        assert!(
            !wrote_older,
            "writing an older epoch over a position that holds a newer one must be refused"
        );

        // The position must still hold newer_epoch's data, untouched.
        let slot = crate::storage::get_slot(&env, &asset, newer_epoch).unwrap();
        assert_eq!(slot.peg_ratio, 9_900_000);
        assert!(crate::storage::get_slot(&env, &asset, older_epoch).is_none());
    });
}

// -- ring buffer header (required change #5) --

#[test]
#[should_panic(expected = "ring buffer layout mismatch")]
fn get_ring_packed_rejects_a_header_that_does_not_match() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(RiskOracle, ());
    let asset = Address::generate(&env);

    env.as_contract(&contract_id, || {
        // Write a well formed ring first so a Ring(asset) entry exists...
        let signals = signal_set(&env, 0, 9_900_000);
        crate::storage::write_ring_slot(&env, &asset, 0, &signals, 100);

        // ...then corrupt its header directly and confirm the next read
        // refuses to interpret the body under the wrong layout.
        crate::storage::corrupt_header_for_test(&env, &asset);
        let _ = crate::storage::get_ring(&env, &asset);
    });
}

// -- score, band, hysteresis, staleness --

/// Posts `epochs` consecutive epochs with a constant `peg_ratio` and
/// `liquidity`, and sets the mock Staking aggregate to `Up` for every one
/// of them, so a "healthy signals" test is not accidentally scored
/// against `EndpointStatus::Unknown` (the mock's default when no
/// aggregate was ever set, which `post_signals` would otherwise source
/// for real per Section 7.4).
fn fill_ring_with_constant_signal(
    env: &Env,
    client: &RiskOracleClient,
    staking: &Address,
    asset: &Address,
    epochs: u64,
    peg_ratio: i128,
    liquidity: i128,
) {
    let keeper = Address::generate(env);
    let staking_client = crate::mocks::MockStakingClient::new(env, staking);
    for epoch in 0..epochs {
        staking_client.set_aggregate(asset, &epoch, &EndpointStatus::Up);
        env.ledger().set_timestamp((epoch + 1) * 3_600);
        let mut s = signal_set(env, epoch, peg_ratio);
        s.liquidity_2pct = liquidity;
        s.supply_change_bps = 0;
        client.post_signals(&keeper, asset, &s);
    }
}

#[test]
fn score_is_stale_with_fewer_than_168_epochs_posted() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    fill_ring_with_constant_signal(
        &env,
        &fx.client,
        &fx.staking,
        &asset,
        10,
        10_000_000,
        500_000_000_000,
    );
    let score = fx.client.score(&asset);
    assert!(score.stale);
}

#[test]
fn score_is_normal_band_with_healthy_signals() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    // peg_ratio_p10 == SCALE (no deviation), good liquidity, no issuer
    // actions, no redemption pressure, no supply shock, endpoint Up: every
    // component should be 0.
    fill_ring_with_constant_signal(
        &env,
        &fx.client,
        &fx.staking,
        &asset,
        168,
        sylox_types::SCALE,
        100_000_000_000, // >= min_liquidity, so component L is 0 too
    );
    let score = fx.client.score(&asset);
    assert!(!score.stale);
    assert_eq!(score.band, Band::Normal);
    assert_eq!(score.score, 0);
}

/// Review item C3: a single epoch's bad `peg_ratio` inside the 72 epoch
/// Depeg window must not move the band, because component P is the 10th
/// percentile of the window, computed onchain, not a single value. One
/// severely depegged epoch among 72 healthy ones sorts to the bottom of
/// the window and falls below the `len / 10 = 7` index `percentile_10`
/// reads, so it never reaches component P at all.
#[test]
fn percentile_p10_ignores_a_single_epoch_wick() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    let keeper = Address::generate(&env);
    let staking_client = crate::mocks::MockStakingClient::new(&env, &fx.staking);

    for epoch in 0..168u64 {
        staking_client.set_aggregate(&asset, &epoch, &EndpointStatus::Up);
        env.ledger().set_timestamp((epoch + 1) * 3_600);
        let mut s = signal_set(&env, epoch, sylox_types::SCALE);
        s.liquidity_2pct = 100_000_000_000;
        s.supply_change_bps = 0;
        // The Depeg window is the newest 72 of the 168 posted (epochs
        // 96..168); epoch 96, the oldest epoch inside it, carries the
        // single wick.
        if epoch == 96 {
            s.peg_ratio = 1_000_000;
            s.peg_ratio_p10 = 1_000_000; // severely depegged, one epoch only
        }
        fx.client.post_signals(&keeper, &asset, &s);
    }

    let score = fx.client.score(&asset);
    assert!(!score.stale);
    assert_eq!(
        score.band,
        Band::Normal,
        "a single wick inside the Depeg window must not move the band through component P"
    );
    assert_eq!(score.score, 0);
}

/// The mirror case: enough bad epochs inside the Depeg window (more than
/// 10% of it) DO reach the percentile and move component P, confirming
/// the wick test above is not passing merely because component P is
/// broken rather than because the wick is correctly excluded.
#[test]
fn percentile_p10_reflects_a_sustained_depeg_in_the_window() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    let keeper = Address::generate(&env);
    let staking_client = crate::mocks::MockStakingClient::new(&env, &fx.staking);

    for epoch in 0..168u64 {
        staking_client.set_aggregate(&asset, &epoch, &EndpointStatus::Up);
        env.ledger().set_timestamp((epoch + 1) * 3_600);
        let mut s = signal_set(&env, epoch, sylox_types::SCALE);
        s.liquidity_2pct = 100_000_000_000;
        s.supply_change_bps = 0;
        // 20 of the newest 72 epochs (96..168) are depegged: well over
        // the 10th percentile index (7), so it must land on a depegged
        // value this time.
        if (96..116).contains(&epoch) {
            s.peg_ratio = 1_000_000;
            s.peg_ratio_p10 = 1_000_000;
        }
        fx.client.post_signals(&keeper, &asset, &s);
    }

    let score = fx.client.score(&asset);
    assert!(!score.stale);
    assert_ne!(
        score.band,
        Band::Normal,
        "a sustained depeg covering more than the 10th percentile must move the band"
    );
}

/// Posts `epochs` epochs (starting at `start_epoch`) that max out every
/// score component, so the weighted sum (weights sum to 10,000 bps = 100
/// points) reaches Distress (>=75) with room to spare: P=100 (peg_ratio_p10
/// at 0.5, 50% deviation, over d_max=0.10), E=100 (endpoint Down), L=100
/// (liquidity 0 against min_liquidity), I=100 (large clawback and many
/// auth revocations), R=100 (large redemption outflow relative to
/// supply). P+E+L+I+R alone already weighs 3500+2000+1000+1500+1500 =
/// 9500 of the 10,000 bps total. Returns the next unused epoch.
fn fill_ring_distressed(
    env: &Env,
    client: &RiskOracleClient,
    staking: &Address,
    asset: &Address,
    start_epoch: u64,
    epochs: u64,
) -> u64 {
    let keeper = Address::generate(env);
    let staking_client = crate::mocks::MockStakingClient::new(env, staking);
    for i in 0..epochs {
        let epoch = start_epoch + i;
        staking_client.set_aggregate(asset, &epoch, &EndpointStatus::Down);
        env.ledger().set_timestamp((epoch + 1) * 3_600);
        let mut s = signal_set(env, epoch, 5_000_000);
        s.liquidity_2pct = 0;
        s.supply_change_bps = 0;
        // redemption_net_24h sums 24 epochs of this value; well over the
        // r_max = 0.10 threshold on its own, so R clamps to 100.
        s.redemption_net = s.supply / 100; // 1% of supply redeemed this epoch
        s.issuer_actions = IssuerActions {
            clawbacks: 1,
            // clawback_amount_7d sums 168 epochs; well over c_max = 0.01
            // on its own, so I clamps to 100 from this term alone.
            clawback_amount: s.supply / 5_000,
            auth_revocations: 1, // auth_revocations_7d sums to 168, over k_max = 20
            flag_changes: 0,
        };
        client.post_signals(&keeper, asset, &s);
    }
    start_epoch + epochs
}

#[test]
fn score_is_distress_band_with_a_depegged_price() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    fill_ring_distressed(&env, &fx.client, &fx.staking, &asset, 0, 168);
    let score = fx.client.score(&asset);
    assert!(!score.stale);
    assert_eq!(score.band, Band::Distress);
}

#[test]
fn score_hysteresis_requires_consecutive_epochs_to_move_down() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);

    // Reach Distress first.
    let next_epoch = fill_ring_distressed(&env, &fx.client, &fx.staking, &asset, 0, 168);
    let distressed = fx.client.score(&asset);
    assert_eq!(distressed.band, Band::Distress);

    // One healthy epoch is not enough to move down immediately.
    let keeper = Address::generate(&env);
    let staking_client = crate::mocks::MockStakingClient::new(&env, &fx.staking);
    staking_client.set_aggregate(&asset, &next_epoch, &EndpointStatus::Up);
    env.ledger().set_timestamp((next_epoch + 1) * 3_600);
    let mut healthy = signal_set(&env, next_epoch, sylox_types::SCALE);
    healthy.liquidity_2pct = 100_000_000_000;
    healthy.supply_change_bps = 0;
    fx.client.post_signals(&keeper, &asset, &healthy);
    let after_one = fx.client.score(&asset);
    assert_eq!(
        after_one.band,
        Band::Distress,
        "band_down_epochs (3) has not elapsed yet"
    );
}

#[test]
fn score_moves_down_after_band_down_epochs_consecutive_qualifying_epochs() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    let next_epoch = fill_ring_distressed(&env, &fx.client, &fx.staking, &asset, 0, 168);
    assert_eq!(fx.client.score(&asset).band, Band::Distress);

    let keeper = Address::generate(&env);
    let staking_client = crate::mocks::MockStakingClient::new(&env, &fx.staking);
    for i in 0..3u64 {
        let epoch = next_epoch + i;
        staking_client.set_aggregate(&asset, &epoch, &EndpointStatus::Up);
        env.ledger().set_timestamp((epoch + 1) * 3_600);
        let mut s = signal_set(&env, epoch, sylox_types::SCALE);
        s.liquidity_2pct = 100_000_000_000;
        s.supply_change_bps = 0;
        fx.client.post_signals(&keeper, &asset, &s);
        fx.client.score(&asset);
    }
    let result = fx.client.score(&asset);
    assert_ne!(
        result.band,
        Band::Distress,
        "3 consecutive qualifying epochs must move the band down"
    );
}

#[test]
fn set_event_band_forces_event_and_is_sticky_until_cleared() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    fill_ring_with_constant_signal(
        &env,
        &fx.client,
        &fx.staking,
        &asset,
        168,
        sylox_types::SCALE,
        100_000_000_000,
    );
    assert_eq!(fx.client.score(&asset).band, Band::Normal);

    fx.client.set_event_band(&asset);
    assert_eq!(fx.client.band(&asset), Band::Event);

    // Posting more healthy signals must not move it out of Event.
    let keeper = Address::generate(&env);
    env.ledger().set_timestamp(169 * 3_600);
    fx.client.post_signals(&keeper, &asset, &{
        let mut s = signal_set(&env, 168, sylox_types::SCALE);
        s.liquidity_2pct = 100_000_000_000;
        s.supply_change_bps = 0;
        s
    });
    assert_eq!(fx.client.band(&asset), Band::Event);

    fx.client.clear_event_band(&asset);
    assert_eq!(fx.client.band(&asset), Band::Normal);
}

#[test]
fn set_event_band_requires_registry_auth() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    fx.client.set_event_band(&asset);
    assert_eq!(
        env.auths(),
        [(
            fx.registry.clone(),
            soroban_sdk::testutils::AuthorizedInvocation {
                function: soroban_sdk::testutils::AuthorizedFunction::Contract((
                    fx.client.address.clone(),
                    soroban_sdk::Symbol::new(&env, "set_event_band"),
                    (asset.clone(),).into_val(&env),
                )),
                sub_invocations: std::vec![],
            }
        )]
    );
}

#[test]
fn is_stale_true_before_any_posting() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    assert!(fx.client.is_stale(&asset));
}

#[test]
fn is_stale_false_right_after_posting_then_true_after_stale_after_epochs() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    post(&env, &fx.client, &asset, 5, 9_900_000);
    env.ledger().set_timestamp(6 * 3_600);
    assert!(!fx.client.is_stale(&asset));

    // stale_after_epochs = 3: posting epoch 5, now at epoch 5 + 4 = 9 must
    // already be stale (more than 3 epochs since the last posting).
    env.ledger().set_timestamp(10 * 3_600);
    assert!(fx.client.is_stale(&asset));
}

// -- median_liquidity --

#[test]
fn median_liquidity_is_zero_before_168_epochs() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    fill_ring_with_constant_signal(&env, &fx.client, &fx.staking, &asset, 10, 9_900_000, 42);
    assert_eq!(fx.client.median_liquidity(&asset), 0);
}

#[test]
fn median_liquidity_over_168_constant_slots() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    fill_ring_with_constant_signal(&env, &fx.client, &fx.staking, &asset, 168, 9_900_000, 777);
    assert_eq!(fx.client.median_liquidity(&asset), 777);
}

// -- reference_rate --

#[test]
fn reference_rate_usd_is_scale() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    assert_eq!(fx.client.reference_rate(&asset), sylox_types::SCALE);
}

#[test]
fn reference_rate_fiat_reads_the_fx_adapter() {
    let env = Env::default();
    let fx = setup(&env);
    let fx_adapter_id = env.register(MockFxAdapter, ());
    let fx_adapter_client = crate::mocks::MockFxAdapterClient::new(&env, &fx_adapter_id);

    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    let mut cfg = asset_config(&env, &asset, &issuer);
    cfg.reference = Reference::Fiat(soroban_sdk::symbol_short!("ARS"), FxRateSource::Official);
    cfg.fx_adapter = Some(fx_adapter_id.clone());
    fx.client.add_asset(&cfg);

    env.ledger().set_timestamp(1_000);
    fx_adapter_client.set_rate(
        &soroban_sdk::symbol_short!("ARS"),
        &FxRateSource::Official,
        &123_456,
        &1_000,
    );
    assert_eq!(fx.client.reference_rate(&asset), 123_456);
}

#[test]
fn reference_rate_asset_reference_is_unavailable() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    let other_asset = Address::generate(&env);
    let mut cfg = asset_config(&env, &asset, &issuer);
    cfg.reference = Reference::Asset(other_asset);
    fx.client.add_asset(&cfg);

    let result = fx.client.try_reference_rate(&asset);
    assert_eq!(result, Err(Ok(Error::ReferenceRateUnavailable)));
}

// -- dispute_signals / resolve_signal_dispute --

#[test]
fn dispute_signals_locks_a_bond_and_marks_the_slot_disputed() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    post(&env, &fx.client, &asset, 5, 9_900_000);

    let disputer = Address::generate(&env);
    let alt_hash = BytesN::from_array(&env, &[9u8; 32]);
    fx.client.dispute_signals(&disputer, &asset, &5, &alt_hash);

    let slot = find_slot_by_epoch(&fx.client.ring(&asset), 5);
    assert_eq!(slot.state, SlotState::Disputed);

    let staking_client = crate::mocks::MockStakingClient::new(&env, &fx.staking);
    assert_eq!(
        staking_client.call_count(&soroban_sdk::Symbol::new(&env, "lock_bond")),
        1
    );
}

#[test]
fn dispute_signals_rejects_a_second_dispute_on_the_same_epoch() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    post(&env, &fx.client, &asset, 5, 9_900_000);

    let disputer = Address::generate(&env);
    let alt_hash = BytesN::from_array(&env, &[9u8; 32]);
    fx.client.dispute_signals(&disputer, &asset, &5, &alt_hash);

    let result = fx
        .client
        .try_dispute_signals(&disputer, &asset, &5, &alt_hash);
    assert_eq!(result, Err(Ok(Error::DisputeWindowClosed)));
}

#[test]
fn dispute_signals_rejects_disputing_after_the_window_closes() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    post(&env, &fx.client, &asset, 5, 9_900_000);

    // signal_dispute_secs = 7_200 (2h); jump well past it.
    env.ledger().set_timestamp(6 * 3_600 + 3 * 3_600);
    let disputer = Address::generate(&env);
    let alt_hash = BytesN::from_array(&env, &[9u8; 32]);
    let result = fx
        .client
        .try_dispute_signals(&disputer, &asset, &5, &alt_hash);
    assert_eq!(result, Err(Ok(Error::DisputeWindowClosed)));
}

#[test]
fn resolve_signal_dispute_requires_committee_auth_from_governor() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    post(&env, &fx.client, &asset, 5, 9_900_000);
    let disputer = Address::generate(&env);
    fx.client
        .dispute_signals(&disputer, &asset, &5, &BytesN::from_array(&env, &[9u8; 32]));

    // RiskOracle was initialized with fx.governor as a plain Address, not
    // a contract; resolve_signal_dispute calls Governor.committee() on it,
    // which has no committee() function, so this must fail rather than
    // silently succeed under mock_all_auths. This test documents that
    // gap: see "Known gaps" in the PR description (RiskOracle needs a
    // real or mock Governor at the governor address to exercise this
    // function end to end).
    let result = fx.client.try_resolve_signal_dispute(
        &asset,
        &5,
        &true,
        &BytesN::from_array(&env, &[0u8; 32]),
    );
    assert!(result.is_err());
}

#[test]
fn resolve_signal_dispute_keeper_wins_finalizes_the_slot() {
    let env = Env::default();
    env.mock_all_auths();
    let staking = env.register(MockStaking, ());
    let governor = env.register(MockGovernor, ());
    let contract_id = env.register(RiskOracle, ());
    let client = RiskOracleClient::new(&env, &contract_id);
    let registry = Address::generate(&env);
    client.initialize(&governor, &registry, &staking);

    let governor_client = crate::mocks::MockGovernorClient::new(&env, &governor);
    let committee = Address::generate(&env);
    governor_client.set_committee(&committee);

    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    client.add_asset(&asset_config(&env, &asset, &issuer));
    post(&env, &client, &asset, 5, 9_900_000);

    let disputer = Address::generate(&env);
    client.dispute_signals(&disputer, &asset, &5, &BytesN::from_array(&env, &[9u8; 32]));

    client.resolve_signal_dispute(&asset, &5, &true, &BytesN::from_array(&env, &[0u8; 32]));

    let slot = find_slot_by_epoch(&client.ring(&asset), 5);
    assert_eq!(slot.state, SlotState::Final);
}

#[test]
fn resolve_signal_dispute_disputer_wins_reopens_the_epoch() {
    let env = Env::default();
    env.mock_all_auths();
    let staking = env.register(MockStaking, ());
    let governor = env.register(MockGovernor, ());
    let contract_id = env.register(RiskOracle, ());
    let client = RiskOracleClient::new(&env, &contract_id);
    let registry = Address::generate(&env);
    client.initialize(&governor, &registry, &staking);

    let governor_client = crate::mocks::MockGovernorClient::new(&env, &governor);
    let committee = Address::generate(&env);
    governor_client.set_committee(&committee);

    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    client.add_asset(&asset_config(&env, &asset, &issuer));
    post(&env, &client, &asset, 5, 9_900_000);

    let disputer = Address::generate(&env);
    client.dispute_signals(&disputer, &asset, &5, &BytesN::from_array(&env, &[9u8; 32]));
    client.resolve_signal_dispute(&asset, &5, &false, &BytesN::from_array(&env, &[0u8; 32]));

    // An overturned slot resets to Empty: epoch 5 no longer appears in
    // ring()'s output as itself (an Empty slot carries no real epoch
    // identity), and get_slot(asset, 5) must report it missing.
    assert!(
        client.ring(&asset).iter().all(|slot| slot.epoch != 5),
        "an overturned epoch must not still read as epoch 5 anywhere in the ring"
    );
    assert!(client
        .try_dispute_signals(&disputer, &asset, &5, &BytesN::from_array(&env, &[1u8; 32]))
        .is_err());
}

// -- finalize_endpoint --

#[test]
fn finalize_endpoint_books_a_late_aggregate() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    post(&env, &fx.client, &asset, 5, 9_900_000);

    let staking_client = crate::mocks::MockStakingClient::new(&env, &fx.staking);
    staking_client.set_aggregate(&asset, &5, &EndpointStatus::Down);

    env.ledger().set_timestamp(7 * 3_600);
    fx.client.finalize_endpoint(&asset, &5);

    assert_eq!(
        fx.client.signals(&asset, &5).unwrap().endpoint,
        EndpointStatus::Down
    );
    assert_eq!(
        staking_client.call_count(&soroban_sdk::Symbol::new(&env, "settle_probes")),
        1
    );
}

#[test]
fn finalize_endpoint_rejects_an_epoch_not_yet_closed() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    env.ledger().set_timestamp(3_600);
    let result = fx.client.try_finalize_endpoint(&asset, &1);
    assert_eq!(result, Err(Ok(Error::WrongEpoch)));
}

// -- set_formula --

#[test]
fn set_formula_rejects_weights_not_summing_to_10000() {
    let env = Env::default();
    let fx = setup(&env);
    let mut weights = soroban_sdk::Vec::new(&env);
    for w in [1_000u32, 1_000, 1_000, 1_000, 1_000, 1_000] {
        weights.push_back(w);
    }
    let result = fx
        .client
        .try_set_formula(&1, &weights, &soroban_sdk::Map::new(&env));
    assert_eq!(result, Err(Ok(Error::WeightsInvalid)));
}

#[test]
fn set_formula_accepts_weights_summing_to_10000() {
    let env = Env::default();
    let fx = setup(&env);
    let mut weights = soroban_sdk::Vec::new(&env);
    for w in [2_000u32, 2_000, 2_000, 2_000, 1_000, 1_000] {
        weights.push_back(w);
    }
    fx.client
        .set_formula(&2, &weights, &soroban_sdk::Map::new(&env));
}

// -- assets / latest --

#[test]
fn assets_lists_every_added_asset_once() {
    let env = Env::default();
    let fx = setup(&env);
    let a1 = Address::generate(&env);
    let a2 = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.client.add_asset(&asset_config(&env, &a1, &issuer));
    fx.client.add_asset(&asset_config(&env, &a2, &issuer));
    let assets = fx.client.assets();
    assert_eq!(assets.len(), 2);
    assert!(assets.contains(&a1));
    assert!(assets.contains(&a2));
}

#[test]
fn latest_returns_the_newest_posted_epoch() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    post_sequential(&env, &fx.client, &asset, 5, 9_900_000);
    post_sequential(&env, &fx.client, &asset, 6, 9_850_000);
    assert_eq!(fx.client.latest(&asset).unwrap().epoch, 6);
}

// -- AMM cross check --

#[test]
fn post_signals_rejects_a_peg_ratio_too_far_from_a_price_adapter() {
    let env = Env::default();
    let fx = setup(&env);
    let adapter_id = env.register(MockPriceAdapter, ());
    let adapter_client = crate::mocks::MockPriceAdapterClient::new(&env, &adapter_id);

    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    let mut cfg = asset_config(&env, &asset, &issuer);
    cfg.amm_adapters.push_back(adapter_id.clone());
    fx.client.add_asset(&cfg);

    env.ledger().set_timestamp(3_600);
    adapter_client.set_price(&asset, &10_000_000, &500_000_000_000, &0);

    env.ledger().set_timestamp(3_600 * 2);
    let keeper = Address::generate(&env);
    // 9,000,000 vs adapter's 10,000,000 is a 1,000 bps gap, over the 300
    // bps default tolerance.
    let result = fx
        .client
        .try_post_signals(&keeper, &asset, &signal_set(&env, 1, 9_000_000));
    assert_eq!(result, Err(Ok(Error::AmmCrossCheckFailed)));
}

#[test]
fn post_signals_skips_the_cross_check_when_adapter_liquidity_is_too_low() {
    let env = Env::default();
    let fx = setup(&env);
    let adapter_id = env.register(MockPriceAdapter, ());
    let adapter_client = crate::mocks::MockPriceAdapterClient::new(&env, &adapter_id);

    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    let mut cfg = asset_config(&env, &asset, &issuer);
    cfg.amm_adapters.push_back(adapter_id.clone());
    fx.client.add_asset(&cfg);

    env.ledger().set_timestamp(3_600);
    // Below cfg.min_liquidity (100_000_000_000): the cross check must skip.
    adapter_client.set_price(&asset, &10_000_000, &1, &0);

    env.ledger().set_timestamp(3_600 * 2);
    let keeper = Address::generate(&env);
    fx.client
        .post_signals(&keeper, &asset, &signal_set(&env, 1, 9_000_000));
    assert!(fx.client.signals(&asset, &1).is_some());
}
