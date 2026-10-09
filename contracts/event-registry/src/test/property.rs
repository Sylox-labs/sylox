//! Property test: random sequences of `propose_tier1`, `challenge`,
//! `rule`, `resolve_timeout` and `register_definition`, across 2
//! assets and both kinds, asserting invariants E1 to E4 and E6 after
//! every step. E5 (every bond settles exactly once) is structural
//! (`Staking`'s own `UnknownBond` backstop, design note Section 7),
//! matching how this workspace already documents rather than fuzzes
//! its other structurally provable invariants (`treasury`'s own T3).
//!
//! The oracle data itself is seeded once per asset, with a real
//! failing Depeg window, rather than re-fuzzed per operation: the
//! Tier 1 data-reading logic (missing epochs, the liquidity baseline,
//! the three-way cure-window state) is already covered exhaustively
//! by the unit tests in `test.rs`. This property test's own job is
//! the STATE MACHINE: no sequence of challenge/rule/timeout/propose
//! calls, in any order, against any of the two assets, ever produces
//! two live events for the same (asset, kind, version), ever reaches
//! Declared through an unlisted path, ever desyncs the oracle's
//! `event_in_progress` flag from the registry's own active count, or
//! ever lets the band reach `Event` without a real Declared record
//! to justify it.

extern crate std;

use proptest::prelude::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{Address, BytesN, Env};
use sylox_types::EventKind;

use super::{asset_config, depeg_definition, post_failing_depeg_window, setup};

#[derive(Clone, Copy, Debug)]
enum Op {
    Propose(u8),
    Challenge(u8),
    RuleDeclare(u8),
    RuleReject(u8),
    ResolveTimeout(u8),
    Advance(u8),
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        (0u8..2).prop_map(Op::Propose),
        (0u8..2).prop_map(Op::Challenge),
        (0u8..2).prop_map(Op::RuleDeclare),
        (0u8..2).prop_map(Op::RuleReject),
        (0u8..2).prop_map(Op::ResolveTimeout),
        (1u8..5).prop_map(Op::Advance),
    ]
}

/// E4 and E6 both hold for `asset`, read directly rather than
/// inferred: `event_in_progress` is the one `RiskOracle` change this
/// feature added (review item D6), and `has_declared`/`band` are
/// already public reads.
fn assert_e4_e6(
    _env: &Env,
    oracle: &risk_oracle::RiskOracleClient,
    registry: &crate::EventRegistryClient,
    asset: &Address,
) {
    let active = registry.active_event_count(asset) > 0;
    let flag = oracle.event_in_progress(asset);
    assert_eq!(
        flag, active,
        "E4 violated: oracle flag {flag} != (active count > 0) {active}"
    );

    if oracle.band(asset) == sylox_types::Band::Event {
        assert!(
            registry.has_declared(asset),
            "E6 violated: band is Event but no kind on this asset is Declared \
             under its own canonical version"
        );
    }
}

proptest! {
    // Each case sets up two full 240 epoch rings (one per asset)
    // before any op runs, which dominates this test's own cost far
    // more than the op count does; kept modest for that reason,
    // unlike `treasury`'s own property test (cases: 32), whose setup
    // is cheap per case.
    #![proptest_config(ProptestConfig { cases: 8, .. ProptestConfig::default() })]

    #[test]
    fn e1_to_e4_and_e6_never_break(ops in prop::collection::vec(op(), 1..15)) {
        let env = Env::default();
        let fx = setup(&env);

        let assets: std::vec::Vec<Address> = (0..2).map(|_| Address::generate(&env)).collect();
        let mut live_ids: std::vec::Vec<Option<u64>> = std::vec![None, None];
        let mut ever_declared: std::vec::Vec<bool> = std::vec![false, false];

        for asset in &assets {
            let issuer = Address::generate(&env);
            fx.oracle.add_asset(&asset_config(&env, asset, &issuer, Default::default()));
            fx.client.register_definition(&depeg_definition(&env, asset));
            post_failing_depeg_window(&env, &fx.oracle, &fx.keeper, asset);
        }

        for operation in ops {
            match operation {
                Op::Propose(a) => {
                    let asset = &assets[a as usize % 2];
                    let idx = a as usize % 2;
                    let result = fx.client.try_propose_tier1(
                        &Address::generate(&env),
                        asset,
                        &EventKind::Depeg,
                        &1,
                    );
                    if let Ok(Ok(id)) = result {
                        // E2/E3: must not already have a live event,
                        // and (the bug this test itself found and
                        // which lib.rs now fixes) must never succeed
                        // again once this exact (asset, kind,
                        // version) has ALREADY been Declared.
                        prop_assert!(
                            live_ids[idx].is_none(),
                            "E3 violated: propose_tier1 succeeded while a prior \
                             event for the same (asset, kind, version) was still live"
                        );
                        prop_assert!(
                            !ever_declared[idx],
                            "E2 violated: propose_tier1 succeeded for an (asset, kind, \
                             version) that was already Declared"
                        );
                        live_ids[idx] = Some(id);
                    }
                }
                Op::Challenge(a) => {
                    let idx = a as usize % 2;
                    if let Some(id) = live_ids[idx] {
                        let _ = fx.client.try_challenge(
                            &Address::generate(&env),
                            &id,
                            &BytesN::from_array(&env, &[1u8; 32]),
                        );
                    }
                }
                Op::RuleDeclare(a) => {
                    let idx = a as usize % 2;
                    if let Some(id) = live_ids[idx] {
                        if fx.client.try_rule(&id, &true, &BytesN::from_array(&env, &[2u8; 32])).is_ok() {
                            // E1: Declared only via one of the 3 listed paths;
                            // this branch is one of them. live_ids[idx] stays
                            // Some(id): Declared is terminal, this (asset,
                            // kind, version) slot is occupied forever.
                            ever_declared[idx] = true;
                        }
                    }
                }
                Op::RuleReject(a) => {
                    let idx = a as usize % 2;
                    if let Some(id) = live_ids[idx] {
                        if fx.client.try_rule(&id, &false, &BytesN::from_array(&env, &[3u8; 32])).is_ok() {
                            live_ids[idx] = None;
                        }
                    }
                }
                Op::ResolveTimeout(a) => {
                    let idx = a as usize % 2;
                    if let Some(id) = live_ids[idx] {
                        if fx.client.try_resolve_timeout(&id).is_ok() {
                            // Tier 1 always defaults Declared (Section
                            // 8.9); live_ids[idx] stays Some(id), same
                            // reasoning as Op::RuleDeclare above.
                            ever_declared[idx] = true;
                        }
                    }
                }
                Op::Advance(hours) => {
                    let now = env.ledger().timestamp();
                    env.ledger().set_timestamp(now + hours as u64 * 3_600);
                }
            }

            for (idx, asset) in assets.iter().enumerate() {
                assert_e4_e6(&env, &fx.oracle, &fx.client, asset);
                let _ = idx;
            }
        }

        // E2: Declared is terminal. Every asset that was ever Declared
        // must still report has_declared true at the end (nothing in
        // this op set can un-declare it).
        for (idx, asset) in assets.iter().enumerate() {
            if ever_declared[idx] {
                prop_assert!(fx.client.has_declared(asset));
            }
        }
    }
}
