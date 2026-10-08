//! Loads `fixtures/golden_vectors.json` and replays each case through
//! the real contract (`post_signals`/`finalize_endpoint`/`score`), so
//! the same file an offchain recompute tool would use to check its own
//! math against this contract is also what proves this contract's math
//! in CI. Required by the Phase 2 review's golden-vectors item.

extern crate std;

use serde::Deserialize;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, BytesN, Env,
};
use sylox_types::{Band, EndpointStatus, IssuerActions, SignalSet};

use super::setup_with_asset;

#[derive(Deserialize)]
struct FixtureFile {
    cases: std::vec::Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: std::string::String,
    #[allow(dead_code)]
    description: std::string::String,
    epochs: std::vec::Vec<EpochFixture>,
    event_in_progress: bool,
    expect: Expect,
}

#[derive(Deserialize)]
struct EpochFixture {
    epoch: u64,
    peg_ratio: i128,
    liquidity_2pct: i128,
    redemption_net: i128,
    supply: i128,
    supply_change_bps: i32,
    clawback_amount: i128,
    auth_revocations: u32,
    endpoint: std::string::String,
}

#[derive(Deserialize)]
struct Expect {
    score: u32,
    band: std::string::String,
    stale: bool,
}

fn parse_endpoint(s: &str) -> EndpointStatus {
    match s {
        "Up" => EndpointStatus::Up,
        "Unknown" => EndpointStatus::Unknown,
        "Degraded" => EndpointStatus::Degraded,
        "Down" => EndpointStatus::Down,
        other => panic!("unknown endpoint status in fixture: {other}"),
    }
}

fn parse_band(s: &str) -> Band {
    match s {
        "Normal" => Band::Normal,
        "Watch" => Band::Watch,
        "Warning" => Band::Warning,
        "Distress" => Band::Distress,
        "Event" => Band::Event,
        other => panic!("unknown band in fixture: {other}"),
    }
}

fn load_fixtures() -> FixtureFile {
    let raw = std::fs::read_to_string(std::concat!(
        std::env!("CARGO_MANIFEST_DIR"),
        "/fixtures/golden_vectors.json"
    ))
    .expect("fixtures/golden_vectors.json must be readable");
    serde_json::from_str(&raw).expect("fixtures/golden_vectors.json must be valid")
}

fn run_case(case: &Case) -> sylox_types::RiskScore {
    let env = Env::default();
    let (fx, asset) = setup_with_asset(&env);
    let keeper = Address::generate(&env);
    let staking_client = crate::mocks::MockStakingClient::new(&env, &fx.staking);

    for e in &case.epochs {
        staking_client.set_aggregate(&asset, &e.epoch, &parse_endpoint(&e.endpoint));
        env.ledger().set_timestamp((e.epoch + 1) * 3_600);
        let s = SignalSet {
            epoch: e.epoch,
            posted_at: 0,
            peg_ratio: e.peg_ratio,
            peg_ratio_p10: e.peg_ratio,
            liquidity_2pct: e.liquidity_2pct,
            redemption_net: e.redemption_net,
            supply: e.supply,
            supply_change_bps: e.supply_change_bps,
            issuer_actions: IssuerActions {
                clawbacks: u32::from(e.clawback_amount != 0),
                clawback_amount: e.clawback_amount,
                auth_revocations: e.auth_revocations,
                flag_changes: 0,
            },
            endpoint: EndpointStatus::Unknown, // overwritten by post_signals from Staking::aggregate.
            inputs_hash: BytesN::from_array(&env, &[1u8; 32]),
            poster: keeper.clone(),
        };
        fx.client.post_signals(&keeper, &asset, &s);
    }

    if case.event_in_progress {
        fx.client.set_event_in_progress(&asset, &true);
    }

    fx.client.score(&asset)
}

#[test]
fn golden_vectors_match_the_fixtures_file() {
    let fixtures = load_fixtures();
    assert!(
        fixtures.cases.len() >= 8,
        "the review requires at least 8 golden vector cases"
    );
    let mut failures = std::vec::Vec::new();
    for case in &fixtures.cases {
        let score = run_case(case);
        if score.score != case.expect.score
            || score.band != parse_band(&case.expect.band)
            || score.stale != case.expect.stale
        {
            failures.push(std::format!(
                "case {}: expected score={} band={} stale={}, got score={} band={:?} stale={}",
                case.name,
                case.expect.score,
                case.expect.band,
                case.expect.stale,
                score.score,
                score.band,
                score.stale
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
