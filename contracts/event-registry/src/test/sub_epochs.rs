//! Tests for spec v1.5 Section 5.9's EventRegistry-side effects:
//! `cover_gate`'s `RecentDepeg` reading unbuilt sub-epochs, and a
//! sub-epoch-built hour's `endpoint` reaching `RecentEndpointOutage`
//! through both of its own write paths (the aggregate already ready
//! at build time, and the late `finalize_endpoint` correction).
//! Reuses `test.rs`'s own `setup`/`asset_config` conventions; never
//! hand-computes a timestamp or epoch boundary.

use soroban_sdk::{testutils::Address as _, testutils::Ledger as _, Address, Env};
use sylox_types::{CoverGate, EndpointStatus, IssuerFlags};

use super::{asset_config, setup, MockStakingClient};

const EPOCH_SECS: u64 = 3_600;
const SUB_EPOCH_SECS: u64 = 300;
const SUB_BACKFILL_SECS: u64 = 7_200;

fn sub_start(hour: u64, sub: u32) -> u64 {
    hour * EPOCH_SECS + sub as u64 * SUB_EPOCH_SECS
}

fn sub_signal_set(
    env: &Env,
    keeper: &Address,
    hour: u64,
    peg_ratio: i128,
) -> sylox_types::SignalSet {
    sylox_types::SignalSet {
        epoch: hour,
        posted_at: 0,
        peg_ratio,
        peg_ratio_p10: peg_ratio,
        liquidity_2pct: 500_000_000_000,
        redemption_net: 0,
        supply: 10_000_000_000_000,
        supply_change_bps: 0,
        issuer_actions: sylox_types::IssuerActions::default(),
        endpoint: EndpointStatus::Unknown,
        inputs_hash: soroban_sdk::BytesN::from_array(env, &[7u8; 32]),
        poster: keeper.clone(),
    }
}

/// Posts all 12 sub-epochs of `hour` at the 300s default, then
/// advances the ledger past the last one's own dispute window so
/// every sub-epoch is effectively Final and the hour is ready to
/// build.
fn post_full_hour(
    env: &Env,
    oracle: &risk_oracle::RiskOracleClient,
    keeper: &Address,
    asset: &Address,
    hour: u64,
    peg_ratio: i128,
) {
    for sub in 0..12u32 {
        let start = sub_start(hour, sub);
        env.ledger().set_timestamp(start + SUB_EPOCH_SECS);
        oracle.post_sub_signals(
            keeper,
            asset,
            &hour,
            &sub,
            &sub_signal_set(env, keeper, hour, peg_ratio),
        );
    }
    env.ledger()
        .set_timestamp(sub_start(hour, 11) + SUB_EPOCH_SECS + SUB_BACKFILL_SECS + 1);
}

/// Section 5.9 S5: `cover_gate`'s `RecentDepeg` must catch a depeg
/// within one `sub_epoch_secs` of it starting, reading the posted (not
/// yet built) sub-epoch directly, not waiting for the hour to build.
#[test]
fn cover_gate_catches_a_depeg_within_one_sub_epoch_before_the_hour_builds() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));

    let hour = 0u64;
    // Only sub 0 posted so far, well below depeg_threshold (9_500_000
    // default); the hour is nowhere near built (11 sub-epochs still
    // outstanding), but the gate must catch this immediately.
    let start = sub_start(hour, 0);
    env.ledger().set_timestamp(start + SUB_EPOCH_SECS);
    fx.oracle.post_sub_signals(
        &fx.keeper,
        &asset,
        &hour,
        &0u32,
        &sub_signal_set(&env, &fx.keeper, hour, 9_000_000),
    );

    assert_eq!(fx.client.cover_gate(&asset), CoverGate::RecentDepeg);
}

/// Section 5.9 S5: once an hour is built, the gate never re-reads its
/// sub-epochs; a wick fully absorbed into the built hour's own
/// averaged `peg_ratio` (here, above threshold) cannot be seen again
/// at sub-epoch granularity, matching the gate's existing sensitivity
/// to a single already-built hourly slot being above threshold.
#[test]
fn cover_gate_ignores_a_wick_inside_an_hour_that_is_already_built() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));

    let hour = 0u64;
    // Sub 0 is a brief wick (9_000_000, itself below depeg_threshold
    // 9_500_000); every other sub-epoch is healthy at 10_000_000. The
    // MEAN across all 12 (9_916_666) stays comfortably above
    // depeg_threshold, so the built hour reads healthy overall even
    // though one sub-epoch inside it, alone, would not have.
    for sub in 0..12u32 {
        let start = sub_start(hour, sub);
        env.ledger().set_timestamp(start + SUB_EPOCH_SECS);
        let peg_ratio = if sub == 0 { 9_000_000 } else { 10_000_000 };
        fx.oracle.post_sub_signals(
            &fx.keeper,
            &asset,
            &hour,
            &sub,
            &sub_signal_set(&env, &fx.keeper, hour, peg_ratio),
        );
    }
    env.ledger()
        .set_timestamp(sub_start(hour, 11) + SUB_EPOCH_SECS + SUB_BACKFILL_SECS + 1);
    fx.oracle.build_hour(&asset, &hour);
    assert!(fx.oracle.is_final(&asset, &hour));

    // Once built, Sub(asset) is no longer consulted for this hour at
    // all; the gate reads only the built, averaged peg_ratio.
    assert_eq!(fx.client.cover_gate(&asset), CoverGate::Clear);
}

/// Section 5.9 (deviation fix): a built hour's `endpoint`, when the
/// `Staking` aggregate is already ready at build time, reaches
/// `cover_gate`'s `RecentEndpointOutage` immediately, the same as an
/// hourly post already does.
#[test]
fn cover_gate_catches_a_built_hour_s_endpoint_outage_set_at_build_time() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));

    let hour = 0u64;
    let staking_client = MockStakingClient::new(&env, &fx.staking);
    staking_client.set_aggregate(&asset, &hour, &EndpointStatus::Down);

    post_full_hour(&env, &fx.oracle, &fx.keeper, &asset, hour, 10_000_000);
    fx.oracle.build_hour(&asset, &hour);
    assert!(fx.oracle.is_final(&asset, &hour));

    assert_eq!(
        fx.client.cover_gate(&asset),
        CoverGate::RecentEndpointOutage
    );
}

/// Section 5.9 (deviation fix): a built hour's `endpoint`, still
/// `Unknown` at build time (the aggregate not ready yet), is corrected
/// by a later `finalize_endpoint` call, and `cover_gate` only sees the
/// outage once that correction lands — the same two step path an
/// hourly post already relies on (`finalize_endpoint_books_a_late_
/// aggregate` in `test.rs`), now proven against a sub-epoch-built
/// hour too. Also confirms `finalize_endpoint`'s write reaches an
/// already-Final sub-epoch-built slot exactly as it does an
/// already-Final hourly slot: the built hour's immutability is never
/// any wider an exemption than that.
#[test]
fn a_built_hour_s_endpoint_is_corrected_by_a_later_finalize_endpoint_call() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));

    let hour = 0u64;
    // No set_aggregate call yet: aggregate(asset, hour) reads Up by
    // the mock's own default. Override it to Unknown explicitly so
    // this test does not depend on that default's own value, only on
    // the two-step correction behavior under test.
    let staking_client = MockStakingClient::new(&env, &fx.staking);
    staking_client.set_aggregate(&asset, &hour, &EndpointStatus::Unknown);

    post_full_hour(&env, &fx.oracle, &fx.keeper, &asset, hour, 10_000_000);
    fx.oracle.build_hour(&asset, &hour);
    assert!(fx.oracle.is_final(&asset, &hour));
    assert_eq!(
        fx.client.cover_gate(&asset),
        CoverGate::Clear,
        "endpoint is still Unknown immediately after build, not yet Down"
    );

    // The probe aggregate becomes available after the fact; anyone
    // calls finalize_endpoint for this same hour.
    staking_client.set_aggregate(&asset, &hour, &EndpointStatus::Down);
    fx.oracle.finalize_endpoint(&asset, &hour);

    assert_eq!(
        fx.oracle.signals(&asset, &hour).unwrap().endpoint,
        EndpointStatus::Down,
        "finalize_endpoint must reach a sub-epoch-built hour's Signals entry"
    );
    assert_eq!(
        fx.client.cover_gate(&asset),
        CoverGate::RecentEndpointOutage,
        "cover_gate must see the corrected endpoint via the built hour's ring slot"
    );
}

/// Section 5.9 S3 (deviation fix): `cover_gate`'s `RecentDepeg` check
/// must keep seeing a depeg sub-epoch even once that hour has a
/// `HeldHour` entry (because ANOTHER sub-epoch in the same hour is
/// disputed), not just while `Sub(asset)`'s own ring still shows it.
/// `RiskOracle.sub_peg_ratios` is `cover_gate`'s own cross-contract
/// read for an unbuilt hour; it must check `HeldHour` the same way
/// `sub_disposition` does, or a disputed hour's depeg signal would go
/// invisible to the gate for as long as the dispute (or the hour's
/// held data) persists — exactly the window an adversarial dispute
/// could exploit to keep selling cover through a real depeg.
#[test]
fn cover_gate_still_sees_a_depeg_sub_epoch_once_the_hour_is_held() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));

    let hour = 0u64;
    // Sub 0: a genuine depeg (below the default depeg_threshold,
    // 9_500_000). Sub 1: disputed, unrelated to the depeg itself, but
    // its own dispute is what puts this hour into HeldHour at all.
    let start0 = sub_start(hour, 0);
    env.ledger().set_timestamp(start0 + SUB_EPOCH_SECS);
    fx.oracle.post_sub_signals(
        &fx.keeper,
        &asset,
        &hour,
        &0u32,
        &sub_signal_set(&env, &fx.keeper, hour, 9_000_000),
    );
    let start1 = sub_start(hour, 1);
    env.ledger().set_timestamp(start1 + SUB_EPOCH_SECS);
    fx.oracle.post_sub_signals(
        &fx.keeper,
        &asset,
        &hour,
        &1u32,
        &sub_signal_set(&env, &fx.keeper, hour, 10_000_000),
    );
    let disputer = Address::generate(&env);
    fx.oracle.dispute_sub_signals(
        &disputer,
        &asset,
        &hour,
        &1u32,
        &soroban_sdk::BytesN::from_array(&env, &[9u8; 32]),
    );

    // The hour now has a HeldHour entry (sub 1's dispute triggered
    // ensure_hour_held, which also copied sub 0's own already-Final
    // data). Rotate Sub(asset) a full 5 hours past hour's own slots,
    // entirely via later hours' own prompt posts, so the PLAIN ring
    // read sub_peg_ratios would otherwise fall back to can no longer
    // see hour's own sub-epochs at all: only HeldHour still can.
    for later_hour in (hour + 1)..=(hour + 5) {
        post_full_hour(&env, &fx.oracle, &fx.keeper, &asset, later_hour, 10_000_000);
    }
    let ratios = fx.oracle.sub_peg_ratios(&asset, &hour);
    assert_eq!(
        ratios.get(0).flatten(),
        Some(9_000_000),
        "sub 0's own depeg value must still read through HeldHour"
    );
    assert_eq!(
        ratios.get(1).flatten(),
        None,
        "sub 1 is currently Disputed; its own value must read None, not whatever HeldHour \
         captured before the dispute opened"
    );

    // cover_gate must still see sub 0's own depeg through HeldHour,
    // even though Sub(asset)'s own ring no longer holds any of this
    // hour's data directly.
    assert_eq!(fx.client.cover_gate(&asset), CoverGate::RecentDepeg);
}
