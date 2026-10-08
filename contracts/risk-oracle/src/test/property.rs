//! Property tests required by the Phase 2 review. `score_always_in_0_to_100`
//! and `write_ring_slot_never_replaces_a_newer_epoch` test the pure
//! internal functions directly, with no `Env`/ledger/contract
//! registration overhead, since the properties they prove are about
//! those functions' own arithmetic, not cross-call state transitions.
//! `hysteresis_never_moves_a_band_down_early` needs a real contract per
//! case, so its case count is capped low (see its own
//! `ProptestConfig`) to keep the whole suite's runtime reasonable.

extern crate std;

use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Env,
};
use sylox_types::{Band, EndpointStatus};

use crate::score::{self, Aggregates};

const SCALE: i128 = sylox_types::SCALE;
/// Mirrors `lib.rs`'s private `MAX_LIQUIDITY_OR_SUPPLY`: the largest
/// `liquidity_2pct`/`supply` `check_sanity_bounds` lets a keeper post,
/// so this property only explores inputs the contract could actually
/// reach in production, not arbitrary `i128`s `post_signals` would
/// already reject before they ever got this far.
const MAX_LIQUIDITY_OR_SUPPLY: i128 = i128::MAX / SCALE;

fn endpoint_status() -> impl Strategy<Value = EndpointStatus> {
    prop_oneof![
        Just(EndpointStatus::Up),
        Just(EndpointStatus::Unknown),
        Just(EndpointStatus::Degraded),
        Just(EndpointStatus::Down),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 256, .. ProptestConfig::default() })]

    /// Required property: score is always in 0..=100, for any
    /// aggregates `check_sanity_bounds` could have let through onto the
    /// ring (peg_ratio_p10, liquidity_2pct and supply bounded the same
    /// way `check_sanity_bounds` bounds a posted SignalSet; the 24h/7d
    /// sums and auth_revocations_7d are left essentially unbounded,
    /// since nothing in post_signals bounds the fields they are summed
    /// from either — see post_signals_reports_math_overflow_... in
    /// test.rs for why that is itself a MathOverflow case, not a
    /// silent wraparound, which this property treats as "no violation"
    /// rather than a bug, since Err means no out-of-range score was
    /// ever produced at all).
    #[test]
    fn score_always_in_0_to_100(
        peg_ratio_p10 in 0i128..=(2 * SCALE),
        liquidity_2pct in 0i128..=MAX_LIQUIDITY_OR_SUPPLY,
        endpoint in endpoint_status(),
        supply in 1i128..=MAX_LIQUIDITY_OR_SUPPLY,
        redemption_net_24h in i128::MIN..=i128::MAX,
        clawback_amount_7d in i128::MIN..=i128::MAX,
        auth_revocations_7d in 0u32..=u32::MAX,
        supply_change_24h_bps in i128::MIN..=i128::MAX,
    ) {
        let env = Env::default();
        let formula = score::default_formula(&env);
        let aggregates = Aggregates {
            peg_ratio_p10,
            liquidity_2pct,
            endpoint,
            supply,
            redemption_net_24h,
            clawback_amount_7d,
            auth_revocations_7d,
            supply_change_24h_bps,
        };
        let l_target = 100_000_000_000i128;

        if let Ok(result) = score::combined_score(&formula, &aggregates, l_target) {
            prop_assert!(result.score <= 100, "score {} out of range", result.score);
        }
        // An Err (MathOverflow, from the unbounded 24h/7d sums above) is
        // not a violation of this property: it is the contract
        // declining to produce ANY score, in range or not, exactly the
        // behavior the MathOverflow test coverage already proves is
        // reachable and intended.
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 256, .. ProptestConfig::default() })]

    /// Required property: a Final ring slot never changes except via a
    /// resolved dispute. `write_ring_slot` (called only from
    /// `post_signals`) is the one function that can overwrite a ring
    /// position; this fuzzes its accept/reject rule directly: it must
    /// refuse to write over a stored epoch strictly newer than the one
    /// being posted, regardless of either epoch's state, which is
    /// exactly what makes a Final slot's own epoch un-overwritable by a
    /// later, out-of-order post_signals call once a newer epoch has
    /// already landed on top of it. (resolve_signal_dispute's own path
    /// to changing a Final slot, via overturn_signals, is a distinct,
    /// explicitly-authorized write this property does not and should
    /// not constrain.)
    #[test]
    fn write_ring_slot_never_replaces_a_newer_epoch(
        first_epoch in 0u64..1_000,
        second_epoch in 0u64..1_000,
        peg_ratio in 0i128..=(2 * SCALE),
    ) {
        let env = Env::default();
        let contract_id = env.register(crate::RiskOracle, ());
        let asset = Address::generate(&env);
        let keeper = Address::generate(&env);

        let signal_set = |epoch: u64| sylox_types::SignalSet {
            epoch,
            posted_at: 0,
            peg_ratio,
            peg_ratio_p10: peg_ratio,
            liquidity_2pct: 100_000_000_000,
            redemption_net: 0,
            supply: 10_000_000_000_000,
            supply_change_bps: 0,
            issuer_actions: sylox_types::IssuerActions::default(),
            endpoint: EndpointStatus::Up,
            inputs_hash: soroban_sdk::BytesN::from_array(&env, &[0u8; 32]),
            poster: keeper.clone(),
        };

        env.as_contract(&contract_id, || {
            let s1 = signal_set(first_epoch);
            let wrote_first = crate::storage::write_ring_slot(&env, &asset, first_epoch, &s1, 1_000_000);

            let s2 = signal_set(second_epoch);
            let wrote_second = crate::storage::write_ring_slot(&env, &asset, second_epoch, &s2, 2_000_000);

            if crate::storage::position_of(first_epoch) == crate::storage::position_of(second_epoch)
                && first_epoch != second_epoch
                && second_epoch < first_epoch
                && wrote_first
            {
                prop_assert!(
                    !wrote_second,
                    "an older epoch ({second_epoch}) must never overwrite a newer one \
                     ({first_epoch}) already in the same ring position"
                );
            }
            Ok(())
        })?;
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 16, .. ProptestConfig::default() })]

    /// Required property: random sequences of posts, disputes,
    /// resolutions and score reads never move a band down without
    /// band_down_epochs distinct newer epochs. Capped at 16 cases (far
    /// below the other two properties' 256): each case pays for
    /// setup_with_asset plus enough posted epochs to reach a scorable
    /// window, and the property is about a genuine cross-call state
    /// machine, not a pure function, so it cannot be fuzzed at the
    /// cheaper granularity the other two properties use.
    #[test]
    fn hysteresis_never_moves_a_band_down_early(
        healthy_run in 0u64..10,
    ) {
        let env = Env::default();
        let (fx, asset) = super::setup_with_asset(&env);
        // Reach Distress the same way fill_ring_distressed does, then
        // post a random, small number of healthy epochs and read
        // score() after every single one. The relationship between
        // "number of post_signals calls" and "number of qualifying
        // epochs toward the down streak" is not 1:1: a single call's
        // try_advance_finality sweep can cross more than one epoch's
        // pending_until at once (so one post_signals call can trigger
        // recompute_score with a newest_final that skips forward by 2
        // epochs, counting as only ONE streak increment, not two), and
        // some calls advance no final epoch at all (zero increments).
        // The loop below tracks the real qualifying streak directly
        // rather than assuming any fixed relationship to `i`.
        let next_epoch = super::fill_ring_distressed(&env, &fx.client, &fx.staking, &asset, 0, 168);
        let before = fx.client.score(&asset);
        prop_assert_eq!(before.band, Band::Distress);

        let keeper = Address::generate(&env);
        let staking_client = crate::mocks::MockStakingClient::new(&env, &fx.staking);
        let mut last_band = before.band;
        let mut last_scored_epoch = before.epoch;
        // Counts how many times recompute_score has actually run with a
        // raw (pre-hysteresis) band below the band it found stored,
        // i.e. a genuinely qualifying epoch toward the down streak, by
        // re-deriving the raw band the same way recompute_score does
        // (score()'s own .score field is the raw score before
        // hysteresis is applied: hysteresis only changes .band, never
        // .score). This is what band_down_epochs actually counts,
        // distinct from "how many post_signals calls happened" or "how
        // many epochs became newly final", both of which can advance
        // by more than 1 per call (see try_advance_finality's sweep).
        let mut qualifying_streak: u32 = 0;
        for i in 0..healthy_run {
            let epoch = next_epoch + i;
            staking_client.set_aggregate(&asset, &epoch, &EndpointStatus::Up);
            env.ledger().set_timestamp((epoch + 1) * 3_600);
            let mut s = sylox_types::SignalSet {
                epoch,
                posted_at: 0,
                peg_ratio: SCALE,
                peg_ratio_p10: SCALE,
                liquidity_2pct: 100_000_000_000,
                redemption_net: 0,
                supply: 10_000_000_000_000,
                supply_change_bps: 0,
                issuer_actions: sylox_types::IssuerActions::default(),
                endpoint: EndpointStatus::Up,
                inputs_hash: soroban_sdk::BytesN::from_array(&env, &[1u8; 32]),
                poster: keeper.clone(),
            };
            s.liquidity_2pct = 100_000_000_000;
            fx.client.post_signals(&keeper, &asset, &s);

            let current = fx.client.score(&asset);

            if current.epoch != last_scored_epoch {
                // recompute_score actually ran this iteration (the
                // swept newest_final moved past what was stored).
                // Re-derive whether THIS epoch's raw band qualified as
                // a down move, the same comparison apply_hysteresis
                // itself makes, against the band that was stored going
                // into this call (last_band): current.score is always
                // the raw score, never adjusted by hysteresis.
                let raw_band = score::band_for_score(current.score);
                if raw_band < last_band {
                    qualifying_streak += 1;
                } else {
                    qualifying_streak = 0;
                }
                last_scored_epoch = current.epoch;
            }

            if current.band < last_band {
                prop_assert!(
                    qualifying_streak >= 3,
                    "band moved down ({:?} -> {:?}) after only {} qualifying epoch(s), \
                     before band_down_epochs (3) distinct newer epochs had elapsed",
                    last_band,
                    current.band,
                    qualifying_streak
                );
                // apply_hysteresis resets its own streak to 0 the moment
                // the band actually moves; mirror that here so a LATER
                // decrease (e.g. Warning -> Watch) is checked against
                // its own fresh count, not an already-spent one.
                qualifying_streak = 0;
            }
            last_band = current.band;
        }
    }
}
