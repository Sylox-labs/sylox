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

    // cover_gate itself never reads HeldHour (Section 5.9 S5
    // footprint-fix review, Option 3): once Sub(asset)'s own ring has
    // rotated past this hour, sub_peg_ratios_in_span_batch returns
    // nothing for it, and the gate falls back to Ring(asset)'s own
    // provisional roll-up instead, which (Option 1's fix) still holds
    // sub 0's real depeg value via provisional_sub_coverage: Some(1),
    // excluding only the disputed sub 1, not the whole hour. Must
    // still see the depeg, just through this different path than
    // sub_peg_ratios above.
    assert_eq!(fx.client.cover_gate(&asset), CoverGate::RecentDepeg);
}

/// Found on testnet: before this fix, posting sub-epochs for an hour
/// with NONE of them past their own `SIGNAL_DISPUTE_SECS` window yet
/// left `Ring(asset)`'s own provisional slot at an all-zero roll-up
/// (`peg_ratio: 0`), which `cover_gate`'s pre-existing, unmodified
/// `any_epoch_below_threshold` read as "below depeg_threshold", a
/// false `RecentDepeg` for every waiting hour's first
/// `signal_dispute_secs` (2h), every single hour. Checks both halves
/// directly: the ring's own provisional slot holds the real posted
/// mean (not zero), and `cover_gate` itself reads `Clear` when that
/// mean is healthy and `RecentDepeg` when it genuinely is not,
/// entirely from the sub-epoch read (R10): `any_epoch_below_
/// threshold` must skip this same waiting hour's own `Ring(asset)`
/// slot (`pending_until == u64::MAX`), so there is exactly one source
/// for this hour's depeg check, not two agreeing by coincidence.
#[test]
fn cover_gate_reads_correctly_before_any_sub_epoch_of_the_hour_clears_its_window() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));

    // Non-zero: the ring's own never-written slots default to
    // epoch 0, so inspecting a hour 0 slot directly (below) could
    // not tell "genuinely absent" apart from "the provisional write
    // this test means to check."
    let hour = 100u64;
    // Two sub-epochs posted, both still well within their own 2h
    // dispute window (post_full_hour-style timestamps, but without
    // ever advancing past pending_until): healthy, near 1.0.
    let start0 = sub_start(hour, 0);
    env.ledger().set_timestamp(start0 + SUB_EPOCH_SECS);
    fx.oracle.post_sub_signals(
        &fx.keeper,
        &asset,
        &hour,
        &0u32,
        &sub_signal_set(&env, &fx.keeper, hour, 9_900_000),
    );
    let start1 = sub_start(hour, 1);
    env.ledger().set_timestamp(start1 + SUB_EPOCH_SECS);
    fx.oracle.post_sub_signals(
        &fx.keeper,
        &asset,
        &hour,
        &1u32,
        &sub_signal_set(&env, &fx.keeper, hour, 10_100_000),
    );

    let ring = fx.oracle.ring(&asset);
    let slot = ring
        .iter()
        .find(|s| s.epoch == hour)
        .expect("a waiting hour with posted sub-epochs must have a ring slot");
    assert_eq!(
        slot.peg_ratio,
        (9_900_000 + 10_100_000) / 2,
        "the ring's own provisional slot must hold the real mean, not zero"
    );
    assert_eq!(
        fx.client.cover_gate(&asset),
        CoverGate::Clear,
        "both posted sub-epochs are healthy (near 1.0); the gate must read Clear"
    );

    // Now post a third, genuinely depegged sub-epoch (still within
    // its own dispute window): the mean of all three might not cross
    // threshold, but the sub-epoch-level check (R10) must catch it
    // regardless of what the hour-level mean says.
    let start2 = sub_start(hour, 2);
    env.ledger().set_timestamp(start2 + SUB_EPOCH_SECS);
    fx.oracle.post_sub_signals(
        &fx.keeper,
        &asset,
        &hour,
        &2u32,
        &sub_signal_set(&env, &fx.keeper, hour, 9_000_000),
    );
    assert_eq!(
        fx.client.cover_gate(&asset),
        CoverGate::RecentDepeg,
        "sub 2's own value is below depeg_threshold; the gate must catch it via the \
         sub-epoch read even though the hour has not built and its own ring slot is \
         still Pending"
    );
}

/// The keeper stops building for 8 hours straight (none of hours
/// `0..8` ever gets a single sub-epoch posted, so each is genuinely
/// missing, not merely waiting), then, well within the 2 hour
/// backfill window of the LAST of those 8 hours, posts a single
/// sub-epoch into it that is below `depeg_threshold`. That hour stays
/// unbuilt (only 1 of its 12 sub-epochs posted), and the OTHER 7
/// hours sit in `Sub(asset)`'s own 5 hour span right alongside it, so
/// `cover_gate` must catch the depeg through the normal in-span
/// sub-epoch read (never `UnbuiltBacklog`: 8 unbuilt hours is nowhere
/// near `MAX_UNBUILT_HOURS_SCANNED_BY_COVER_GATE`, and never a false
/// Clear, confirming a real backlog of unbuilt hours does not itself
/// mask a depeg in any one of them).
#[test]
fn keeper_stops_building_for_8_hours_then_posts_a_depeg_in_one_of_them() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));

    // Advance 8 hours with nothing posted at all: every hour in
    // 0..8 is genuinely missing (not merely waiting on its own
    // backfill window), a real build backlog.
    let last_stalled_hour = 7u64;
    env.ledger()
        .set_timestamp(last_stalled_hour * EPOCH_SECS + 1);

    assert_eq!(
        fx.client.cover_gate(&asset),
        CoverGate::Clear,
        "8 hours with nothing posted at all must read Clear, not a false depeg or backlog"
    );

    // Within the last stalled hour's own backfill window, the keeper
    // finally posts one sub-epoch, genuinely depegged. The hour stays
    // unbuilt (11 of its 12 sub-epochs are still missing).
    let start = sub_start(last_stalled_hour, 0);
    env.ledger().set_timestamp(start + SUB_EPOCH_SECS);
    fx.oracle.post_sub_signals(
        &fx.keeper,
        &asset,
        &last_stalled_hour,
        &0u32,
        &sub_signal_set(&env, &fx.keeper, last_stalled_hour, 9_000_000),
    );

    assert_eq!(
        fx.client.cover_gate(&asset),
        CoverGate::RecentDepeg,
        "a depeg posted into one hour of an 8-hour unbuilt backlog must still be caught; \
         the backlog itself must not mask it"
    );
}

/// An hour posted whole through the hourly fallback path, then
/// disputed at the HOUR level (`RiskOracle.dispute_signals`, not
/// `dispute_sub_signals`): its own `Ring(asset)` slot's `peg_ratio`
/// etc. ARE the one real, contested reading itself, not a roll-up
/// that already excludes anything, so the gate's own `None` branch
/// (`provisional_sub_coverage` unset on this path) must keep excluding
/// it exactly as before the footprint-fix review, never reading it
/// via the `Some(n)` branch meant only for the sub-epoch path.
#[test]
fn an_hourly_fallback_hour_disputed_at_hour_level_is_still_excluded_from_the_gate() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));

    let hour = 0u64;
    env.ledger().set_timestamp((hour + 1) * EPOCH_SECS);
    fx.oracle.post_signals(
        &fx.keeper,
        &asset,
        &sub_signal_set(&env, &fx.keeper, hour, 9_000_000),
    );

    let disputer = Address::generate(&env);
    fx.oracle.dispute_signals(
        &disputer,
        &asset,
        &hour,
        &soroban_sdk::BytesN::from_array(&env, &[9u8; 32]),
    );

    assert_eq!(
        fx.client.cover_gate(&asset),
        CoverGate::Clear,
        "an hour disputed at the hour level (hourly fallback path) must still be excluded \
         from the gate's own read: its peg_ratio is the contested value itself, not a \
         roll-up that already excludes anything"
    );
}

/// Every one of an hour's posted sub-epochs is currently disputed:
/// zero real coverage. The provisional roll-up must read as NO DATA
/// (`provisional_sub_coverage == Some(0)`), never as a real reading of
/// exactly 0 (which would be a false depeg under any reasonable
/// threshold), and `cover_gate` must treat this the same as a missing
/// hour, never RecentDepeg.
#[test]
fn every_sub_epoch_disputed_reads_as_no_data_never_a_false_depeg() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    fx.oracle
        .add_asset(&asset_config(&env, &asset, &issuer, IssuerFlags::default()));

    // Non-zero: the ring's own never-written slots default to epoch
    // 0, which would otherwise collide with a genuine hour 0 here.
    let hour = 100u64;
    let disputer = Address::generate(&env);
    // Two sub-epochs posted, both immediately disputed: zero
    // non-disputed coverage.
    for sub in 0..2u32 {
        let start = sub_start(hour, sub);
        env.ledger().set_timestamp(start + SUB_EPOCH_SECS);
        fx.oracle.post_sub_signals(
            &fx.keeper,
            &asset,
            &hour,
            &sub,
            &sub_signal_set(&env, &fx.keeper, hour, 9_000_000),
        );
        fx.oracle.dispute_sub_signals(
            &disputer,
            &asset,
            &hour,
            &sub,
            &soroban_sdk::BytesN::from_array(&env, &[9u8 + sub as u8; 32]),
        );
    }

    let ring = fx.oracle.ring(&asset);
    let slot = ring
        .iter()
        .find(|s| s.epoch == hour)
        .expect("a disputed hour must still have a ring slot, even with zero coverage");
    assert_eq!(
        slot.provisional_sub_coverage,
        Some(0),
        "zero non-disputed sub-epochs must read as an explicit Some(0), never inferred from \
         peg_ratio"
    );
    assert_eq!(
        fx.client.cover_gate(&asset),
        CoverGate::Clear,
        "a hour with zero real sub-epoch coverage (every posted sub-epoch disputed) must \
         read Clear, never a false depeg from an unset peg_ratio reading as 0"
    );
}
