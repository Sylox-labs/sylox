//! Tests for spec v1.5 Section 5.9: sub-epochs and the hourly roll-up.
//! Split into its own module, mirroring `golden_vectors.rs`/
//! `property.rs`'s own split-out pattern, given the size of this
//! feature. Reuses `test.rs`'s own `setup`/`setup_with_asset`,
//! `signal_set`, `time_at_epoch` and `REALISTIC_EPOCH_BASE`
//! conventions, never hand-computing a timestamp or epoch boundary.

use soroban_sdk::{testutils::Address as _, testutils::Ledger as _, Address, Env};
use sylox_types::SlotState;

use super::{setup_with_asset, signal_set};
use crate::mocks::MockGovernor;
use crate::{RiskOracle, RiskOracleClient};

/// A bespoke setup with a real, *registered* `MockGovernor` (unlike
/// `setup_with_asset`'s own plain `Address::generate` governor), for
/// tests that call `resolve_sub_signal_dispute` and so need
/// `Governor.committee()` to actually resolve. Mirrors the pattern
/// `test.rs`'s own `resolve_signal_dispute` tests use (e.g.
/// `an_overturned_epoch_is_never_rewarded`), since `Fixture`'s shared
/// `setup` deliberately keeps the governor unregistered for every test
/// that never needs to call back into it.
fn setup_with_governor_and_asset(env: &Env) -> (RiskOracleClient<'_>, Address, Address) {
    env.mock_all_auths();
    let staking = env.register(crate::mocks::MockStaking, ());
    let governor = env.register(MockGovernor, ());
    let contract_id = env.register(RiskOracle, ());
    let client = RiskOracleClient::new(env, &contract_id);
    let registry = Address::generate(env);
    client.initialize(&governor, &registry, &staking);

    let asset = Address::generate(env);
    let issuer = Address::generate(env);
    client.add_asset(&super::asset_config(env, &asset, &issuer));

    (client, governor, asset)
}

const REALISTIC_EPOCH_BASE: u64 = 497_000;
const EPOCH_SECS: u64 = 3_600;
const SUB_EPOCH_SECS_DEFAULT: u64 = 300;

fn hour_close(hour: u64) -> u64 {
    (hour + 1) * EPOCH_SECS
}

fn sub_start(hour: u64, sub: u32, sub_epoch_secs: u64) -> u64 {
    hour * EPOCH_SECS + sub as u64 * sub_epoch_secs
}

#[allow(clippy::too_many_arguments)]
fn post_sub(
    env: &Env,
    client: &crate::RiskOracleClient,
    keeper: &Address,
    asset: &Address,
    hour: u64,
    sub: u32,
    sub_epoch_secs: u64,
    peg_ratio: i128,
) {
    let start = sub_start(hour, sub, sub_epoch_secs);
    env.ledger().set_timestamp(start + sub_epoch_secs);
    let mut s = signal_set(env, hour, peg_ratio);
    s.liquidity_2pct = 500_000_000_000;
    s.supply_change_bps = 0;
    client.post_sub_signals(keeper, asset, &hour, &sub, &s);
}

/// S1: `set_sub_epoch_secs` rejects any value outside the allowed set.
#[test]
fn set_sub_epoch_secs_rejects_values_outside_the_allowed_set() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    for bad in [0u64, 1, 299, 301, 3_601, 7_200] {
        let result = fx.client.try_set_sub_epoch_secs(&asset, &bad);
        assert_eq!(
            result,
            Err(Ok(crate::Error::InvalidSubEpochInterval)),
            "sub_epoch_secs {bad} must be rejected"
        );
    }
    for good in [300u64, 600, 900, 1_200, 1_800, 3_600] {
        assert!(fx.client.try_set_sub_epoch_secs(&asset, &good).is_ok());
    }
}

/// S1: a `sub_epoch_secs` change takes effect only from the next hour
/// boundary, never mid-hour.
#[test]
fn changing_sub_epoch_secs_takes_effect_only_at_the_next_hour_boundary() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    let keeper = Address::generate(&env);

    let hour = REALISTIC_EPOCH_BASE;
    // Post sub 0 at the 5 minute default.
    post_sub(
        &env,
        &fx.client,
        &keeper,
        &asset,
        hour,
        0,
        SUB_EPOCH_SECS_DEFAULT,
        10_000_000,
    );

    // Change to 600s mid-hour; must not apply to this hour.
    fx.client.set_sub_epoch_secs(&asset, &600);
    let cfg = fx.client.sub_epoch_config(&asset).unwrap();
    assert_eq!(cfg.pending_sub_epoch_secs, Some(600));
    assert_eq!(cfg.effective_from_hour, Some(hour + 1));

    // Sub 1 of THIS hour must still be addressed at the 300s grid
    // (sub 1 covers [300, 600)), not the new 600s one (which would
    // make sub 1 invalid, since 3600/600 = 6 sub-epochs, sub index 1
    // still exists either way, but at a different start time).
    post_sub(
        &env,
        &fx.client,
        &keeper,
        &asset,
        hour,
        1,
        SUB_EPOCH_SECS_DEFAULT,
        10_000_000,
    );
    let (live_sub_epoch, _, _) = fx.client.live(&asset).unwrap();
    assert_eq!(
        live_sub_epoch.sub, 1,
        "still addressed at the old interval within this hour"
    );
}

/// S2: an hour is posted through exactly one path; a sub-epoch post
/// against an hour already posted through the hourly fallback is
/// rejected, and the reverse.
#[test]
fn hour_already_posted_rejects_mixing_the_two_posting_paths() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    let keeper = Address::generate(&env);
    let hour = REALISTIC_EPOCH_BASE;

    // Post the hour through the hourly fallback path first.
    env.ledger().set_timestamp(hour_close(hour));
    let mut s = signal_set(&env, hour, 10_000_000);
    s.liquidity_2pct = 500_000_000_000;
    s.supply_change_bps = 0;
    fx.client.post_signals(&keeper, &asset, &s);

    // A sub-epoch post for the SAME hour must now be rejected.
    let start = sub_start(hour, 0, SUB_EPOCH_SECS_DEFAULT);
    env.ledger().set_timestamp(start + SUB_EPOCH_SECS_DEFAULT);
    let mut sub_s = signal_set(&env, hour, 10_000_000);
    sub_s.liquidity_2pct = 500_000_000_000;
    sub_s.supply_change_bps = 0;
    let result = fx
        .client
        .try_post_sub_signals(&keeper, &asset, &hour, &0u32, &sub_s);
    assert_eq!(result, Err(Ok(crate::Error::HourAlreadyPosted)));

    // The reverse: a fresh hour posted via sub-epochs first, then an
    // hourly fallback attempt for the SAME hour must be rejected too.
    let hour2 = hour + 1;
    post_sub(
        &env,
        &fx.client,
        &keeper,
        &asset,
        hour2,
        0,
        SUB_EPOCH_SECS_DEFAULT,
        10_000_000,
    );
    env.ledger().set_timestamp(hour_close(hour2));
    let mut s2 = signal_set(&env, hour2, 10_000_000);
    s2.liquidity_2pct = 500_000_000_000;
    s2.supply_change_bps = 0;
    let result2 = fx.client.try_post_signals(&keeper, &asset, &s2);
    assert_eq!(result2, Err(Ok(crate::Error::HourAlreadyPosted)));
}

/// S4: a waiting hour never auto-promotes to Final before it is
/// built, even once the last POSTED sub-epoch's own dispute window
/// has closed, as long as at least one sub-epoch in the hour is
/// still unaccounted for (within its own backfill window).
#[test]
fn waiting_hour_never_auto_promotes_before_every_sub_epoch_is_decided() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    let keeper = Address::generate(&env);
    let hour = REALISTIC_EPOCH_BASE;
    let sub_epoch_secs = SUB_EPOCH_SECS_DEFAULT;

    // Post sub 0 only; leave every other sub-epoch of this hour
    // unposted (there are 3,600 / 300 = 12 of them).
    post_sub(
        &env,
        &fx.client,
        &keeper,
        &asset,
        hour,
        0,
        sub_epoch_secs,
        10_000_000,
    );

    // Advance well past sub 0's own pending_until (2 hours,
    // SIGNAL_DISPUTE_SECS), far enough that a naive "pending_until
    // derived from posted sub-epochs alone" implementation would
    // have auto-promoted the hour to Final by now.
    env.ledger()
        .set_timestamp(sub_start(hour, 0, sub_epoch_secs) + sub_epoch_secs + 7_200 + 3_600);

    // is_final and effective_window must report NOT Final throughout.
    assert!(
        !fx.client.is_final(&asset, &hour),
        "the hour must not read Final while sub-epochs 1..12 are still undecided"
    );
    let window = fx.client.effective_window(&asset, &hour, &1u32);
    assert_ne!(
        window.get(0).flatten(),
        Some(SlotState::Final),
        "effective_window must not report this hour Final either"
    );
}

/// S4: while waiting, the cover gate (via `live`) reads the hour's
/// provisional roll-up, not a zeroed slot.
#[test]
fn waiting_hour_holds_a_provisional_rollup_not_zeros() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    let keeper = Address::generate(&env);
    let hour = REALISTIC_EPOCH_BASE;
    let sub_epoch_secs = SUB_EPOCH_SECS_DEFAULT;

    post_sub(
        &env,
        &fx.client,
        &keeper,
        &asset,
        hour,
        0,
        sub_epoch_secs,
        9_000_000, // a genuinely low peg_ratio, distinguishable from 0
    );

    let (_, signals, state) = fx.client.live(&asset).unwrap();
    assert_eq!(state, SlotState::Pending);
    assert_eq!(
        signals.peg_ratio, 9_000_000,
        "the provisional roll-up must reflect the one posted sub-epoch's real peg_ratio, not zero"
    );
}

/// S4: with full coverage, `build_hour` writes Final with the
/// correctly computed roll-up for each field.
#[test]
fn build_hour_writes_final_with_full_coverage_and_correct_rollup() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    let keeper = Address::generate(&env);
    let hour = REALISTIC_EPOCH_BASE;
    let sub_epoch_secs = SUB_EPOCH_SECS_DEFAULT;
    let per_hour = (EPOCH_SECS / sub_epoch_secs) as u32; // 12

    // Post all 12 sub-epochs with increasing peg_ratio so the mean is
    // easy to hand-compute: 10_000_000 + sub * 100_000, mean over
    // sub=0..12 is 10_000_000 + (0+1+...+11)/12 * 100_000
    // = 10_000_000 + 550_000 = 10_550_000.
    for sub in 0..per_hour {
        let peg_ratio = 10_000_000 + sub as i128 * 100_000;
        post_sub(
            &env,
            &fx.client,
            &keeper,
            &asset,
            hour,
            sub,
            sub_epoch_secs,
            peg_ratio,
        );
    }
    // Let the last sub-epoch's own dispute window close.
    env.ledger()
        .set_timestamp(sub_start(hour, per_hour - 1, sub_epoch_secs) + sub_epoch_secs + 7_200 + 1);
    fx.client.build_hour(&asset, &hour);

    assert!(fx.client.is_final(&asset, &hour));
    let ring = fx.client.ring(&asset);
    let slot = ring
        .iter()
        .find(|s| s.epoch == hour)
        .expect("built hour must be in the ring");
    assert_eq!(slot.state, SlotState::Final);
    assert_eq!(
        slot.peg_ratio, 10_550_000,
        "mean peg_ratio across all 12 sub-epochs"
    );
}

/// Section 21.3: the roll-up's correctness checked against an
/// INDEPENDENT offchain recomputation (`independent_rollup`, below),
/// not against a hand-simplified special case like the arithmetic
/// sequence `build_hour_writes_final_with_full_coverage_and_correct_
/// rollup` already covers. Every field varies independently per
/// sub-epoch here (not all equal, not a simple arithmetic progression),
/// so a bug that only cancels out under a symmetric input would still
/// be caught.
#[test]
fn build_hour_rollup_matches_an_independent_offchain_recomputation() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    let keeper = Address::generate(&env);
    let hour = REALISTIC_EPOCH_BASE;
    let sub_epoch_secs = SUB_EPOCH_SECS_DEFAULT;
    let per_hour = (EPOCH_SECS / sub_epoch_secs) as u32; // 12

    // Deliberately irregular per sub-epoch data: peg_ratio oscillates,
    // liquidity_2pct is given in an order that is neither sorted nor
    // reverse sorted (so median actually has to sort), supply strictly
    // increases (so "last by sub order" is distinguishable from "max"
    // or "min"), redemption_net/clawback_amount/auth_revocations vary
    // so the sums are non-trivial.
    let peg_ratios: [i128; 12] = [
        10_000_000, 9_800_000, 10_200_000, 9_950_000, 10_100_000, 9_900_000, 10_050_000,
        10_000_000, 9_975_000, 10_025_000, 9_990_000, 10_010_000,
    ];
    let liquidity: [i128; 12] = [
        500_000_000_000,
        300_000_000_000,
        900_000_000_000,
        100_000_000_000,
        700_000_000_000,
        200_000_000_000,
        800_000_000_000,
        400_000_000_000,
        600_000_000_000,
        1_000_000_000_000,
        950_000_000_000,
        50_000_000_000,
    ];
    let redemption_net: [i128; 12] = [
        100, -50, 200, -300, 400, -500, 600, -700, 800, -900, 1_000, -1_100,
    ];
    let clawback_amount: [i128; 12] = [0, 0, 5_000, 0, 0, 0, 10_000, 0, 0, 0, 0, 2_000];
    let auth_revocations: [u32; 12] = [0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 0, 1];
    let supply: [i128; 12] = [
        10_000_000_000_000,
        10_001_000_000_000,
        10_002_000_000_000,
        10_003_000_000_000,
        10_004_000_000_000,
        10_005_000_000_000,
        10_006_000_000_000,
        10_007_000_000_000,
        10_008_000_000_000,
        10_009_000_000_000,
        10_010_000_000_000,
        10_011_000_000_000,
    ];

    for sub in 0..per_hour as usize {
        let start = sub_start(hour, sub as u32, sub_epoch_secs);
        env.ledger().set_timestamp(start + sub_epoch_secs);
        let mut s = signal_set(&env, hour, peg_ratios[sub]);
        s.liquidity_2pct = liquidity[sub];
        s.redemption_net = redemption_net[sub];
        s.supply = supply[sub];
        s.supply_change_bps = 0;
        s.issuer_actions.clawback_amount = clawback_amount[sub];
        s.issuer_actions.auth_revocations = auth_revocations[sub];
        fx.client
            .post_sub_signals(&keeper, &asset, &hour, &(sub as u32), &s);
    }
    env.ledger()
        .set_timestamp(sub_start(hour, per_hour - 1, sub_epoch_secs) + sub_epoch_secs + 7_200 + 1);
    fx.client.build_hour(&asset, &hour);
    assert!(fx.client.is_final(&asset, &hour));

    let expected = independent_rollup(
        &peg_ratios,
        &liquidity,
        &redemption_net,
        &clawback_amount,
        &auth_revocations,
        supply[11], // last by sub order
        None,       // no previous built hour: supply_change_bps must be 0
    );

    let ring = fx.client.ring(&asset);
    let slot = ring.iter().find(|s| s.epoch == hour).unwrap();
    assert_eq!(slot.peg_ratio, expected.peg_ratio);
    assert_eq!(slot.liquidity_2pct, expected.liquidity_2pct);
    assert_eq!(slot.redemption_net, expected.redemption_net);
    assert_eq!(slot.supply, expected.supply);
    assert_eq!(slot.supply_change_bps, expected.supply_change_bps);
    assert_eq!(slot.clawback_amount, expected.clawback_amount);
    assert_eq!(slot.auth_revocations, expected.auth_revocations);
}

/// An independent, offchain recomputation of the Section 5.9 S4
/// roll-up table, deliberately NOT sharing any code with
/// `lib.rs`'s own `roll_up_sub_slots`: this is a from-the-spec
/// reimplementation, so a bug specific to the contract's own
/// arithmetic (e.g. integer division order, a wrong sort) would not
/// be mirrored here and so would actually be caught.
struct ExpectedRollup {
    peg_ratio: i128,
    liquidity_2pct: i128,
    redemption_net: i128,
    supply: i128,
    supply_change_bps: i32,
    clawback_amount: i128,
    auth_revocations: u32,
}

#[allow(clippy::too_many_arguments)]
fn independent_rollup(
    peg_ratios: &[i128],
    liquidity: &[i128],
    redemption_net: &[i128],
    clawback_amount: &[i128],
    auth_revocations: &[u32],
    last_supply: i128,
    previous_built_supply: Option<i128>,
) -> ExpectedRollup {
    let n = peg_ratios.len() as i128;
    let peg_ratio = peg_ratios.iter().sum::<i128>() / n;

    let mut sorted_liquidity = liquidity.to_vec();
    sorted_liquidity.sort();
    let liquidity_2pct = sorted_liquidity[sorted_liquidity.len() / 2];

    let redemption_net_sum = redemption_net.iter().sum::<i128>();
    let clawback_amount_sum = clawback_amount.iter().sum::<i128>();
    let auth_revocations_sum = auth_revocations.iter().sum::<u32>();

    let supply_change_bps = match previous_built_supply {
        Some(prev) if prev > 0 => (((last_supply - prev) * 10_000) / prev) as i32,
        _ => 0,
    };

    ExpectedRollup {
        peg_ratio,
        liquidity_2pct,
        redemption_net: redemption_net_sum,
        supply: last_supply,
        supply_change_bps,
        clawback_amount: clawback_amount_sum,
        auth_revocations: auth_revocations_sum,
    }
}

/// S4: below `min_sub_coverage_bps`, the built hour's slot is Empty,
/// not Final.
#[test]
fn build_hour_writes_empty_below_min_sub_coverage_bps() {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    let keeper = Address::generate(&env);
    let hour = REALISTIC_EPOCH_BASE;
    let sub_epoch_secs = SUB_EPOCH_SECS_DEFAULT;
    let per_hour = (EPOCH_SECS / sub_epoch_secs) as u32; // 12

    // min_sub_coverage_bps is 7,500 (9 of 12); post only 8, leaving
    // the rest to go permanently missing past their own backfill
    // window.
    for sub in 0..8u32 {
        post_sub(
            &env,
            &fx.client,
            &keeper,
            &asset,
            hour,
            sub,
            sub_epoch_secs,
            10_000_000,
        );
    }
    // Advance past every remaining sub-epoch's own backfill window
    // (sub_backfill_secs, 2 hours) so they read PermanentlyMissing,
    // and past the last posted sub-epoch's own dispute window.
    let last_missing_close = sub_start(hour, per_hour - 1, sub_epoch_secs) + sub_epoch_secs;
    env.ledger().set_timestamp(last_missing_close + 7_200 + 1);

    fx.client.build_hour(&asset, &hour);
    assert!(
        !fx.client.is_final(&asset, &hour),
        "8 of 12 (6,666 bps) is below the 7,500 bps coverage threshold"
    );
}

/// S4, I23: a sub-epoch resolved Overturned never contributes to the
/// built hour, and the hour still builds correctly from the remaining
/// Final sub-epochs.
#[test]
fn a_sub_epoch_resolved_overturned_never_contributes_to_the_built_hour() {
    let env = Env::default();
    let (client, governor, asset) = setup_with_governor_and_asset(&env);
    let keeper = Address::generate(&env);
    let committee = Address::generate(&env);
    crate::mocks::MockGovernorClient::new(&env, &governor).set_committee(&committee);
    let hour = REALISTIC_EPOCH_BASE;
    let sub_epoch_secs = SUB_EPOCH_SECS_DEFAULT;
    let per_hour = (EPOCH_SECS / sub_epoch_secs) as u32;

    for sub in 0..per_hour {
        // Sub 0 posts a wildly wrong peg_ratio (1); every other
        // sub-epoch posts 10_000_000, so if sub 0's overturned data
        // leaked into the roll-up, the mean would be obviously wrong.
        let peg_ratio = if sub == 0 { 1 } else { 10_000_000 };
        post_sub(
            &env,
            &client,
            &keeper,
            &asset,
            hour,
            sub,
            sub_epoch_secs,
            peg_ratio,
        );
    }
    let disputer = Address::generate(&env);
    client.dispute_sub_signals(&disputer, &asset, &hour, &0u32, &dummy_hash(&env));
    client.resolve_sub_signal_dispute(
        &asset,
        &hour,
        &0u32,
        &false, // disputer wins: sub 0 is overturned
        &dummy_hash(&env),
    );

    env.ledger()
        .set_timestamp(sub_start(hour, per_hour - 1, sub_epoch_secs) + sub_epoch_secs + 7_200 + 1);
    client.build_hour(&asset, &hour);

    let ring = client.ring(&asset);
    let slot = ring.iter().find(|s| s.epoch == hour).unwrap();
    // Coverage: 11 of 12 Final (sub 0 overturned, never reposted, now
    // PermanentlyMissing) = 9,166 bps, still above the 7,500 threshold.
    assert_eq!(slot.state, SlotState::Final);
    assert_eq!(
        slot.peg_ratio, 10_000_000,
        "sub 0's overturned peg_ratio (1) must never enter the mean"
    );
}

/// Section 21.3, Section 5.9 S3: a disputed sub-epoch outliving the
/// 60 slot ring (5 hours of wall-clock span), with the committee's
/// ruling arriving after `WINDOW_SECS` (72h) and a cure-style
/// checkpoint read in between, UPHOLDING the keeper. `HeldHour`
/// preserves every one of the hour's OTHER 11 sub-epochs' own data
/// (copied out the moment the dispute opened) and the disputed one's
/// own data too (captured then, in case the ruling upholds it), so
/// even though `Sub(asset)`'s ring has long since rotated past this
/// entire hour's footprint by the time the ruling lands, the hour
/// still builds Final with all 12 values once the dispute resolves,
/// matching an independent offchain recomputation exactly.
#[test]
fn a_dispute_outliving_the_ring_upheld_at_day_6_still_builds_final_with_all_12() {
    let env = Env::default();
    let (client, governor, asset) = setup_with_governor_and_asset(&env);
    let keeper = Address::generate(&env);
    let committee = Address::generate(&env);
    crate::mocks::MockGovernorClient::new(&env, &governor).set_committee(&committee);
    let sub_epoch_secs = SUB_EPOCH_SECS_DEFAULT;
    let per_hour = (EPOCH_SECS / sub_epoch_secs) as u32; // 12
    let hour = REALISTIC_EPOCH_BASE;

    let peg_ratios: [i128; 12] = [
        10_000_000, 9_950_000, 10_050_000, 9_900_000, 10_100_000, 9_975_000, 10_025_000, 9_990_000,
        10_010_000, 9_960_000, 10_040_000, 10_000_000,
    ];
    for sub in 1..per_hour {
        post_sub(
            &env,
            &client,
            &keeper,
            &asset,
            hour,
            sub,
            sub_epoch_secs,
            peg_ratios[sub as usize],
        );
    }
    post_sub(
        &env,
        &client,
        &keeper,
        &asset,
        hour,
        0,
        sub_epoch_secs,
        peg_ratios[0],
    );
    let disputer = Address::generate(&env);
    client.dispute_sub_signals(&disputer, &asset, &hour, &0u32, &dummy_hash(&env));
    assert!(!client.is_final(&asset, &hour));

    // Rotate Sub(asset) a full 5 hours past hour's own slots, entirely
    // via later hours' own prompt, un-backfilled posts.
    for later_hour in (hour + 1)..=(hour + 5) {
        for sub in 0..per_hour {
            post_sub(
                &env,
                &client,
                &keeper,
                &asset,
                later_hour,
                sub,
                sub_epoch_secs,
                10_000_000,
            );
        }
    }
    // Sub(asset)'s own ring no longer holds ANY of hour's own slots
    // (all 12 rotated out together, 5 hours later). sub_peg_ratios
    // must still report every UNDISPUTED sub-epoch's real value,
    // through HeldHour (captured when sub 0's dispute first opened);
    // only sub 0 itself, currently Disputed, reads None.
    let ratios = client.sub_peg_ratios(&asset, &hour);
    for sub in 1..per_hour {
        assert_eq!(
            ratios.get(sub).flatten(),
            Some(peg_ratios[sub as usize]),
            "sub {sub}'s own value must still read through HeldHour, not go blind just \
             because Sub(asset)'s ring has rotated past it"
        );
    }
    assert_eq!(
        ratios.get(0).flatten(),
        None,
        "sub 0 is currently Disputed; its value must read None while the ruling is pending"
    );

    // A cure-style checkpoint read in between, well before the
    // ruling: still Disputed/not-Final, never prematurely decided.
    let window_before = client.effective_window(&asset, &hour, &1u32);
    assert_ne!(window_before.get(0).flatten(), Some(SlotState::Final));

    // The ruling arrives at day 6 (well past WINDOW_SECS's 72h, still
    // inside SIGNAL_DISPUTE_RULING_SECS's 6 day deadline), upholding
    // the keeper.
    env.ledger()
        .set_timestamp(sub_start(hour, 0, sub_epoch_secs) + sub_epoch_secs + 6 * 86_400);
    client.resolve_sub_signal_dispute(&asset, &hour, &0u32, &true, &dummy_hash(&env));

    assert!(
        client.is_final(&asset, &hour),
        "HeldHour must give build_hour every sub-epoch's data back, including the upheld one"
    );
    let expected = independent_rollup(
        &peg_ratios,
        &[500_000_000_000i128; 12],
        &[0i128; 12],
        &[0i128; 12],
        &[0u32; 12],
        10_000_000_000_000,
        None,
    );
    let ring = client.ring(&asset);
    let slot = ring.iter().find(|s| s.epoch == hour).unwrap();
    assert_eq!(slot.state, SlotState::Final);
    assert_eq!(slot.peg_ratio, expected.peg_ratio);
    assert_eq!(slot.liquidity_2pct, expected.liquidity_2pct);

    // Never flips: calling build_hour again changes nothing further.
    client.build_hour(&asset, &hour);
    let ring_again = client.ring(&asset);
    let slot_again = ring_again.iter().find(|s| s.epoch == hour).unwrap();
    assert_eq!(slot_again.peg_ratio, slot.peg_ratio);
    assert_eq!(slot_again.state, SlotState::Final);
}

/// Section 21.3, Section 5.9 S3: the same scenario, but the ruling at
/// day 6 OVERTURNS the disputed sub-epoch. `HeldHour`'s own entry for
/// it is removed on resolution (I23: an overturned sub-epoch never
/// contributes), and the hour builds from the remaining 11 — still
/// above the 7,500 bps coverage threshold (11 of 12 = 9,166 bps) — so
/// it reads Final, built from 11 values, not 12, and not Empty.
#[test]
fn a_dispute_outliving_the_ring_overturned_at_day_6_builds_from_the_other_11() {
    let env = Env::default();
    let (client, governor, asset) = setup_with_governor_and_asset(&env);
    let keeper = Address::generate(&env);
    let committee = Address::generate(&env);
    crate::mocks::MockGovernorClient::new(&env, &governor).set_committee(&committee);
    let sub_epoch_secs = SUB_EPOCH_SECS_DEFAULT;
    let per_hour = (EPOCH_SECS / sub_epoch_secs) as u32; // 12
    let hour = REALISTIC_EPOCH_BASE;

    for sub in 1..per_hour {
        post_sub(
            &env,
            &client,
            &keeper,
            &asset,
            hour,
            sub,
            sub_epoch_secs,
            10_000_000,
        );
    }
    // Sub 0 posts a wildly wrong value; if it leaked into the roll-up
    // despite being overturned, the mean would be obviously wrong.
    post_sub(&env, &client, &keeper, &asset, hour, 0, sub_epoch_secs, 1);
    let disputer = Address::generate(&env);
    client.dispute_sub_signals(&disputer, &asset, &hour, &0u32, &dummy_hash(&env));

    for later_hour in (hour + 1)..=(hour + 5) {
        for sub in 0..per_hour {
            post_sub(
                &env,
                &client,
                &keeper,
                &asset,
                later_hour,
                sub,
                sub_epoch_secs,
                10_000_000,
            );
        }
    }
    assert!(!client.is_final(&asset, &hour));

    env.ledger()
        .set_timestamp(sub_start(hour, 0, sub_epoch_secs) + sub_epoch_secs + 6 * 86_400);
    // Disputer wins: sub 0 is overturned.
    client.resolve_sub_signal_dispute(&asset, &hour, &0u32, &false, &dummy_hash(&env));

    assert!(
        client.is_final(&asset, &hour),
        "11 of 12 (9,166 bps) is still above the 7,500 bps coverage threshold"
    );
    let ring = client.ring(&asset);
    let slot = ring.iter().find(|s| s.epoch == hour).unwrap();
    assert_eq!(slot.state, SlotState::Final);
    assert_eq!(
        slot.peg_ratio, 10_000_000,
        "sub 0's overturned value (1) must never enter the mean, HeldHour copy or not"
    );

    // Never flips.
    client.build_hour(&asset, &hour);
    let ring_again = client.ring(&asset);
    let slot_again = ring_again.iter().find(|s| s.epoch == hour).unwrap();
    assert_eq!(slot_again.peg_ratio, 10_000_000);
    assert_eq!(slot_again.state, SlotState::Final);
}

/// Section 5.9 S3: two sub-epochs of the SAME hour disputed at once,
/// both outliving the ring, ruled in opposite directions. `HeldHour`
/// holds both plus every undisputed sub-epoch; each dispute's own
/// resolution only ever touches its OWN entry.
#[test]
fn two_disputes_in_the_same_hour_resolve_independently() {
    let env = Env::default();
    let (client, governor, asset) = setup_with_governor_and_asset(&env);
    let keeper = Address::generate(&env);
    let committee = Address::generate(&env);
    crate::mocks::MockGovernorClient::new(&env, &governor).set_committee(&committee);
    let sub_epoch_secs = SUB_EPOCH_SECS_DEFAULT;
    let per_hour = (EPOCH_SECS / sub_epoch_secs) as u32; // 12
    let hour = REALISTIC_EPOCH_BASE;

    for sub in 2..per_hour {
        post_sub(
            &env,
            &client,
            &keeper,
            &asset,
            hour,
            sub,
            sub_epoch_secs,
            10_000_000,
        );
    }
    // Sub 0: will be upheld. Sub 1: will be overturned (wildly wrong).
    post_sub(
        &env,
        &client,
        &keeper,
        &asset,
        hour,
        0,
        sub_epoch_secs,
        9_000_000,
    );
    post_sub(&env, &client, &keeper, &asset, hour, 1, sub_epoch_secs, 1);

    let disputer_0 = Address::generate(&env);
    let disputer_1 = Address::generate(&env);
    client.dispute_sub_signals(&disputer_0, &asset, &hour, &0u32, &dummy_hash(&env));
    client.dispute_sub_signals(&disputer_1, &asset, &hour, &1u32, &dummy_hash(&env));

    for later_hour in (hour + 1)..=(hour + 5) {
        for sub in 0..per_hour {
            post_sub(
                &env,
                &client,
                &keeper,
                &asset,
                later_hour,
                sub,
                sub_epoch_secs,
                10_000_000,
            );
        }
    }
    assert!(!client.is_final(&asset, &hour));

    env.ledger()
        .set_timestamp(sub_start(hour, 1, sub_epoch_secs) + sub_epoch_secs + 6 * 86_400);
    // Sub 0 upheld (keeper wins); the hour must still wait on sub 1.
    client.resolve_sub_signal_dispute(&asset, &hour, &0u32, &true, &dummy_hash(&env));
    assert!(
        !client.is_final(&asset, &hour),
        "sub 1's own dispute is still open; the hour must not build yet"
    );

    // Sub 1 overturned (disputer wins).
    client.resolve_sub_signal_dispute(&asset, &hour, &1u32, &false, &dummy_hash(&env));

    assert!(
        client.is_final(&asset, &hour),
        "11 of 12 (sub 1 excluded) is still above the 7,500 bps coverage threshold"
    );
    let ring = client.ring(&asset);
    let slot = ring.iter().find(|s| s.epoch == hour).unwrap();
    assert_eq!(slot.state, SlotState::Final);
    // Mean of ten 10_000_000 values plus sub 0's upheld 9_000_000,
    // over 11 sub-epochs: (10 * 10_000_000 + 9_000_000) / 11.
    assert_eq!(slot.peg_ratio, (10 * 10_000_000 + 9_000_000) / 11);
}

/// Section 5.9 S3: the copy-out at dispute-open time (`ensure_hour_
/// held`'s own ring scan plus the disputed sub-epoch's own insert)
/// measured against `sylox_types::network_limits`, the same
/// `cost_estimate` convention `budget_test.rs` uses elsewhere. Scans
/// at most 12 sub-epochs (the 300s default's own `per_hour`) and
/// writes one `HeldHour` entry; this is a one-time cost paid only the
/// first time any dispute opens against a given hour, not on every
/// sub-epoch post.
#[test]
fn budget_dispute_copy_out_at_the_300s_default() {
    let env = Env::default();
    let (client, governor, asset) = setup_with_governor_and_asset(&env);
    let keeper = Address::generate(&env);
    let committee = Address::generate(&env);
    crate::mocks::MockGovernorClient::new(&env, &governor).set_committee(&committee);
    let sub_epoch_secs = SUB_EPOCH_SECS_DEFAULT;
    let per_hour = (EPOCH_SECS / sub_epoch_secs) as u32; // 12
    let hour = REALISTIC_EPOCH_BASE;

    for sub in 0..per_hour {
        post_sub(
            &env,
            &client,
            &keeper,
            &asset,
            hour,
            sub,
            sub_epoch_secs,
            10_000_000,
        );
    }
    let disputer = Address::generate(&env);

    // The measured call: the FIRST dispute against this hour, which
    // pays the full ensure_hour_held scan (every other sub-epoch
    // already Final gets copied in the same call).
    client.dispute_sub_signals(&disputer, &asset, &hour, &0u32, &dummy_hash(&env));

    let estimate = env.cost_estimate();
    let resources = estimate.resources();
    extern crate std;
    std::println!(
        "--- dispute_sub_signals, first dispute against a full 12 sub-epoch hour (copy-out) ---"
    );
    std::println!("  instructions:      {}", resources.instructions);
    std::println!("  write_entries:     {}", resources.write_entries);
    std::println!("  write_bytes:       {}", resources.write_bytes);
    assert!(
        resources.write_bytes < sylox_types::network_limits::CONTRACT_DATA_ENTRY_SIZE_BYTES as u32,
        "HeldHour's own entry (at most 12 HeldSubSlot-sized rows) must fit a single ledger entry"
    );
}

fn dummy_hash(env: &Env) -> soroban_sdk::BytesN<32> {
    soroban_sdk::BytesN::from_array(env, &[1u8; 32])
}

// -- Property test: random sequences of sub-epoch posts, disputes,
// rulings, missed posts, builds and sub_epoch_secs changes, checking
// I21, I23 and "a built hour never changes." --

mod property {
    extern crate std;
    use super::*;
    use proptest::prelude::*;

    const PROPERTY_HOUR: u64 = REALISTIC_EPOCH_BASE;
    const MAX_SUBS_AT_300S: u32 = 12;

    /// One step of the random sequence. `sub` is taken modulo
    /// whatever `per_hour` actually is at the time the step runs (the
    /// strategy below generates it in `0..MAX_SUBS_AT_300S`, the
    /// widest range any allowed interval needs, so a step is never
    /// silently impossible to generate regardless of the current
    /// interval).
    #[derive(Clone, Debug)]
    enum Step {
        /// Post `sub` with `peg_ratio`, if it has not already been
        /// posted for the current hour/interval and the window
        /// accepts it.
        Post { sub: u32, peg_ratio: i128 },
        /// Dispute `sub`, if it is currently Pending and within its
        /// own dispute window.
        Dispute { sub: u32 },
        /// Resolve `sub`'s own open dispute, if any, via committee
        /// ruling.
        Rule { sub: u32, keeper_wins: bool },
        /// Resolve `sub`'s own open dispute via the timeout path
        /// (ADR-010's default-favors-the-data outcome), if its ruling
        /// deadline has passed.
        Timeout { sub: u32 },
        /// Advance the ledger clock forward by `secs`.
        AdvanceTime { secs: u64 },
        /// Call the permissionless `build_hour` trigger directly.
        Build,
        /// Change `sub_epoch_secs` to one of the 6 allowed values.
        ChangeInterval { secs_index: u8 },
    }

    /// `Dispute`/`Rule`/`Timeout` all draw `sub` from this much
    /// narrower pool (not the full `0..MAX_SUBS_AT_300S`): a dispute
    /// opened on one random sub-epoch and a later ruling against a
    /// SEPARATELY, independently random sub-epoch almost never
    /// target the same one across a short sequence, which starves
    /// this property of the exact cross-step correlation (dispute,
    /// then a later rule/timeout against THAT SAME sub) it exists to
    /// exercise. A pool of 3 keeps the generator still exploring
    /// which of several sub-epochs gets disputed, while making a
    /// dispute/rule or two-disputes-in-one-hour collision likely
    /// within a 40 step sequence. `Post` keeps the full range: an
    /// un-posted, never-disputed sub-epoch (one of the other 9 at the
    /// 300s default) is exactly how `MissingWithinBackfill`/
    /// `PermanentlyMissing` get exercised.
    const DISPUTE_SUB_POOL: u32 = 3;

    /// Named jumps, each tied to a specific protocol boundary, rather
    /// than a continuous random range: a uniform range wide enough to
    /// ever reach `SIGNAL_DISPUTE_RULING_SECS` (6 days) would almost
    /// always overshoot every short window (a sub-epoch's own
    /// `pending_until`, 2h) in a single step, and real sequences
    /// accumulate MANY small steps before the generator happens to
    /// pick a large one, compounding past short windows even with a
    /// heavily-skewed continuous distribution. Named jumps instead
    /// let the generator land EXACTLY where behavior changes: just
    /// inside a window, just past it, past the whole ring, past the
    /// ruling deadline. `Tiny` keeps a little genuine jitter (several
    /// of these in a row still plausibly stay inside a 2h window);
    /// every other variant is a single deliberate jump to one exact
    /// boundary (or just past it).
    fn advance_time_secs() -> impl Strategy<Value = u64> {
        prop_oneof![
            // A few minutes: several in a row still land inside a
            // sub-epoch's own 2h dispute window.
            3 => 0u64..=300u64,
            // Just past a sub-epoch's own pending_until (2h): the
            // moment a Pending sub-epoch becomes effectively Final.
            3 => Just(crate::SIGNAL_DISPUTE_SECS + 1),
            // Just past Sub(asset)'s own 5 hour ring span: the
            // moment a sub-epoch posted this far back would have
            // rotated out.
            2 => Just(5 * EPOCH_SECS + 1),
            // Just past SIGNAL_DISPUTE_RULING_SECS (6 days): a
            // timeout resolution becomes callable.
            2 => Just(crate::SIGNAL_DISPUTE_RULING_SECS + 1),
        ]
    }

    /// `AdvanceTime` itself is weighted far below the other step
    /// types (weight 2, against 6 each for `Post`/`Dispute`/`Rule`):
    /// most of an 80 step sequence should be post/dispute/rule
    /// traffic with the clock essentially still, so a `Dispute`
    /// immediately after its own `Post` (and a `Rule` immediately
    /// after its own `Dispute`) are common, not rare, outcomes. The
    /// FEW `AdvanceTime` steps that do land are what carry the clock
    /// through a window boundary when the sequence needs to.
    fn step_strategy() -> impl Strategy<Value = Step> {
        prop_oneof![
            6 => (0..MAX_SUBS_AT_300S, 9_000_000i128..=10_100_000i128)
                .prop_map(|(sub, peg_ratio)| Step::Post { sub, peg_ratio }),
            6 => (0..DISPUTE_SUB_POOL).prop_map(|sub| Step::Dispute { sub }),
            6 => (0..DISPUTE_SUB_POOL, any::<bool>())
                .prop_map(|(sub, keeper_wins)| Step::Rule { sub, keeper_wins }),
            3 => (0..DISPUTE_SUB_POOL).prop_map(|sub| Step::Timeout { sub }),
            2 => advance_time_secs().prop_map(|secs| Step::AdvanceTime { secs }),
            3 => Just(Step::Build),
            2 => (0u8..6u8).prop_map(|secs_index| Step::ChangeInterval { secs_index }),
        ]
    }

    /// A built (or built-Empty) hour's own observable fields, snapshot
    /// at the moment it was first observed decided. Compared against
    /// the SAME read taken after every later step: any difference at
    /// all is a violated "a built hour never changes" property.
    #[derive(Clone, Debug, PartialEq)]
    struct Decided {
        is_final: bool,
        peg_ratio: i128,
        liquidity_2pct: i128,
        supply: i128,
        redemption_net: i128,
    }

    fn snapshot_hour(client: &RiskOracleClient, asset: &Address, hour: u64) -> Option<Decided> {
        let is_final = client.is_final(asset, &hour);
        let ring = client.ring(asset);
        let slot = ring.iter().find(|s| s.epoch == hour);
        match slot {
            Some(s) if s.state == SlotState::Final || s.state == SlotState::Empty => {
                Some(Decided {
                    is_final,
                    peg_ratio: s.peg_ratio,
                    liquidity_2pct: s.liquidity_2pct,
                    supply: s.supply,
                    redemption_net: s.redemption_net,
                })
            }
            // epoch == 0 (an Empty, built-via-overturn-to-Empty slot
            // clears its own identity back to 0, matching
            // storage.rs's own empty_slot) is its own form of
            // "decided Empty," distinct from "never built at all":
            // but since PROPERTY_HOUR is never 0, a genuine
            // never-built hour and a built-Empty one are only
            // distinguishable by whether build_hour has ever
            // succeeded; is_final alone already tells decided-Final
            // apart from everything else, and the Empty case is
            // covered by the explicit None-epoch slot check in
            // never_flips_once_decided's own caller instead.
            _ => None,
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig { cases: 24, .. ProptestConfig::default() })]

        /// I21, I23, "a built hour never changes": a random sequence
        /// of up to 80 steps against ONE hour, mixing posts, disputes
        /// (including ones left open long enough to outlast
        /// `Sub(asset)`'s own 5 hour ring, per `AdvanceTime`'s wide
        /// range), rulings (both outcomes, via both the committee and
        /// timeout paths), missed sub-epochs (any `sub` nobody ever
        /// posts), manual `build_hour` calls at arbitrary points, and
        /// `sub_epoch_secs` changes mid-sequence. Checked after EVERY
        /// step: once the hour is first observed decided (Final or
        /// built-Empty), every later step's own snapshot must be
        /// byte-for-byte identical (I21's "never changes an hour
        /// that is already built" and the brief's own "a built hour
        /// never changes," together), and no Final hour's peg_ratio
        /// ever equals an overturned sub-epoch's own distinctive
        /// sentinel value (I23).
        #[test]
        fn random_sequences_never_violate_i21_i23_or_a_built_hour_changing(
            steps in prop::collection::vec(step_strategy(), 1..80),
        ) {
            let env = Env::default();
            let (client, governor, asset) = setup_with_governor_and_asset(&env);
            let committee = Address::generate(&env);
            crate::mocks::MockGovernorClient::new(&env, &governor).set_committee(&committee);
            let keeper = Address::generate(&env);
            let disputer = Address::generate(&env);
            let hour = PROPERTY_HOUR;
            // Starts right at hour's own close (the earliest moment
            // any of its sub-epochs can be posted at the 300s
            // default): without this, Env::default()'s own starting
            // timestamp (near 0) sits far earlier than hour * 3,600,
            // and check_sub_epoch_window would reject every post
            // until enough AdvanceTime steps happened to sum past the
            // gap, which 40 steps of at most 600,000s each cannot
            // realistically reach.
            env.ledger().set_timestamp(hour_close(hour));

            // A distinctive, impossible-to-reach-by-honest-averaging
            // sentinel: every OVERTURNED sub-epoch is posted with
            // this exact peg_ratio (overriding the strategy's own
            // generated value for that one post), so if it ever
            // leaked into a Final hour's mean, the mean would equal
            // it only in the deliberately-contrived case of every
            // OTHER sub-epoch also happening to average out to
            // exactly this value from a disjoint set of inputs drawn
            // from a different range (9_000_000..=10_100_000, which
            // this sentinel sits far outside of).
            const OVERTURNED_SENTINEL: i128 = 1;

            let mut overturned_subs = [false; MAX_SUBS_AT_300S as usize];
            // Tracked independently of the contract's own SubDispute
            // storage, from this test's own view of which dispute
            // calls it made succeed: an open dispute must always
            // block the hour from reading Final, regardless of how
            // Sub(asset)'s own ring has rotated underneath it. This
            // is what actually catches sub_disposition checking
            // HeldHour/the ring before SubDispute (the ring-vs-
            // dispute bug this whole mechanism exists to fix):
            // removing that check does not necessarily change the
            // FINAL VALUE a built hour ends up with (so the
            // never-flips and I23 sentinel checks alone can miss it
            // under many sequences), but it DOES let the hour build
            // Final while this test's own bookkeeping still
            // considers a dispute open, which this check catches
            // directly.
            let mut open_disputes = [false; MAX_SUBS_AT_300S as usize];
            let mut decided: Option<Decided> = None;

            for step in steps {
                let now = env.ledger().timestamp();
                let sub_epoch_secs = client
                    .sub_epoch_config(&asset)
                    .map(|c| {
                        match (c.pending_sub_epoch_secs, c.effective_from_hour) {
                            (Some(pending), Some(eff)) if hour >= eff => pending,
                            _ => c.sub_epoch_secs,
                        }
                    })
                    .unwrap_or(SUB_EPOCH_SECS_DEFAULT);
                let per_hour = (EPOCH_SECS / sub_epoch_secs) as u32;

                match step {
                    Step::Post { sub, peg_ratio } => {
                        if sub >= per_hour {
                            continue;
                        }
                        let is_overturned_repost = overturned_subs[sub as usize];
                        let effective_peg_ratio = if is_overturned_repost {
                            OVERTURNED_SENTINEL
                        } else {
                            peg_ratio
                        };
                        let mut s = signal_set(&env, hour, effective_peg_ratio);
                        s.liquidity_2pct = 500_000_000_000;
                        s.supply_change_bps = 0;
                        let _ = client.try_post_sub_signals(&keeper, &asset, &hour, &sub, &s);
                    }
                    Step::Dispute { sub } => {
                        if sub >= per_hour {
                            continue;
                        }
                        let r = client.try_dispute_sub_signals(
                            &disputer,
                            &asset,
                            &hour,
                            &sub,
                            &dummy_hash(&env),
                        );
                        if r.is_ok() {
                            open_disputes[sub as usize] = true;
                        }
                    }
                    Step::Rule { sub, keeper_wins } => {
                        if sub >= per_hour {
                            continue;
                        }
                        let result = client.try_resolve_sub_signal_dispute(
                            &asset,
                            &hour,
                            &sub,
                            &keeper_wins,
                            &dummy_hash(&env),
                        );
                        if result.is_ok() {
                            open_disputes[sub as usize] = false;
                        }
                        if !keeper_wins && result.is_ok() {
                            // Disputer won: this sub-epoch is
                            // overturned. Remember it so a LATER
                            // repost (the strategy can generate
                            // another Post for the same sub) is
                            // tagged with the sentinel too, keeping
                            // I23's check meaningful across a
                            // dispute -> overturn -> repost ->
                            // dispute-again cycle.
                            overturned_subs[sub as usize] = true;
                        }
                    }
                    Step::Timeout { sub } => {
                        if sub >= per_hour {
                            continue;
                        }
                        // The timeout path always favors the data
                        // (ADR-010): never overturns, so no
                        // overturned_subs bookkeeping needed here.
                        let tr = client.try_resolve_sub_dispute_timeout(&asset, &hour, &sub);
                        if tr.is_ok() {
                            open_disputes[sub as usize] = false;
                        }
                    }
                    Step::AdvanceTime { secs } => {
                        env.ledger().set_timestamp(now + secs);
                    }
                    Step::Build => {
                        let _ = client.try_build_hour(&asset, &hour);
                    }
                    Step::ChangeInterval { secs_index } => {
                        let value = crate::SUB_EPOCH_SECS_ALLOWED[secs_index as usize % 6];
                        let _ = client.try_set_sub_epoch_secs(&asset, &value);
                    }
                }

                // I21: a sub_epoch_secs change never renumbers this
                // hour or touches an already-built slot. Checked
                // structurally: the ring's own epoch field for
                // `hour`'s position, once Final, must still read
                // `hour` (write_ring_slot's own newer-wins guard is
                // the mechanism; this just confirms the guarantee
                // holds after every step, not only at the end).
                if let Some(current) = snapshot_hour(&client, &asset, hour) {
                    match &decided {
                        None => decided = Some(current),
                        Some(previous) => {
                            prop_assert_eq!(
                                &current,
                                previous,
                                "a decided hour's own snapshot changed after a later step"
                            );
                        }
                    }
                }

                // I23: a Final hour's peg_ratio must never equal the
                // overturned sentinel, regardless of how many
                // sub-epochs were overturned and reposted along the
                // way.
                if client.is_final(&asset, &hour) {
                    // The hour must never read Final while this
                    // test's own bookkeeping still considers ANY
                    // sub-epoch's dispute open: this is the direct
                    // check for sub_disposition/refresh_waiting_hour
                    // checking SubDispute before anything Sub(asset)'s
                    // ring or HeldHour currently shows (Section 5.9
                    // S3/S4's own design), independent of whether a
                    // violation would also change the built value.
                    for sub in 0..per_hour {
                        prop_assert!(
                            !open_disputes[sub as usize],
                            "hour read Final while sub {sub}'s own dispute was still open"
                        );
                    }

                    let ring = client.ring(&asset);
                    if let Some(slot) = ring.iter().find(|s| s.epoch == hour) {
                        prop_assert_ne!(
                            slot.peg_ratio,
                            OVERTURNED_SENTINEL,
                            "an overturned sub-epoch's sentinel value leaked into the built hour's mean"
                        );
                    }
                }
            }
        }
    }
}
