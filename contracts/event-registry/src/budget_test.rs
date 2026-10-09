//! Resource spike for `propose_tier1` and `finalize` against a full
//! Depeg window (the worst case Tier 1 data read touches: 240 ring
//! slots read via `ring()`, scanned for the 72 window epochs plus the
//! 168 epoch baseline). Numbers reported against the shared network
//! limits (`sylox_types::network_limits`), per the task brief's own
//! instruction, at 50% of each. Self-contained, matching
//! `risk-oracle`'s own `budget_test.rs` convention, rather than
//! reaching into `test.rs`'s own private fixture (a sibling module
//! cannot see it anyway).

extern crate std;

use soroban_sdk::testutils::{cost_estimate::CostEstimate, Address as _, Ledger as _};
use soroban_sdk::{contract, contractimpl, Address, BytesN, Env};
use std::println;
use sylox_types::network_limits::{
    TX_MAX_INSTRUCTIONS, TX_MAX_READ_LEDGER_ENTRIES, TX_MAX_WRITE_BYTES,
    TX_MAX_WRITE_LEDGER_ENTRIES,
};
use sylox_types::{
    AssetConfig, EndpointStatus, EventDefinition, EventKind, IssuerActions, IssuerFlags, Reference,
    SignalSet,
};

use crate::{EventRegistry, EventRegistryClient};

const EPOCH_SECS: u64 = 3_600;

/// Minimal mock `Staking`, only what `RiskOracle.post_signals` needs.
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

fn depeg_definition(asset: &Address) -> EventDefinition {
    EventDefinition {
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

fn post_run(
    env: &Env,
    oracle: &risk_oracle::RiskOracleClient,
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

/// Builds a full, failing 240 epoch Depeg window (168 healthy
/// baseline, 72 failing), then advances the clock past
/// `SIGNAL_DISPUTE_SECS` so every epoch is effectively Final,
/// matching `test.rs`'s own `post_failing_depeg_window` convention,
/// duplicated here for the same self-containment reason as the rest
/// of this file.
fn post_failing_depeg_window(
    env: &Env,
    oracle: &risk_oracle::RiskOracleClient,
    keeper: &Address,
    asset: &Address,
) {
    post_run(env, oracle, keeper, asset, 0, 168, 9_900_000);
    post_run(env, oracle, keeper, asset, 168, 72, 9_000_000);
    let now = env.ledger().timestamp();
    env.ledger().set_timestamp(now + 7_200 + 1);
}

fn setup(env: &Env) -> (EventRegistryClient<'_>, risk_oracle::RiskOracleClient<'_>) {
    env.mock_all_auths();
    let governor = Address::generate(env);
    let staking = env.register(MockStaking, ());
    let oracle_id = env.register(risk_oracle::RiskOracle, ());
    let oracle = risk_oracle::RiskOracleClient::new(env, &oracle_id);
    let registry_id = env.register(EventRegistry, ());
    oracle.initialize(&governor, &registry_id, &staking);

    let factory = Address::generate(env);
    let usdc = Address::generate(env);
    let client = EventRegistryClient::new(env, &registry_id);
    client.initialize(&governor, &oracle_id, &staking, &factory, &usdc);

    (client, oracle)
}

fn print_resources(label: &str, estimate: &CostEstimate) {
    let resources = estimate.resources();
    let fee = estimate.fee();
    println!("--- {label} ---");
    println!("  instructions:        {}", resources.instructions);
    println!("  mem_bytes:           {}", resources.mem_bytes);
    println!("  disk_read_entries:   {}", resources.disk_read_entries);
    println!("  memory_read_entries: {}", resources.memory_read_entries);
    println!("  disk_read_bytes:     {}", resources.disk_read_bytes);
    println!("  write_entries:       {}", resources.write_entries);
    println!("  write_bytes:         {}", resources.write_bytes);
    println!("  fee.total (stroops): {}", fee.total);
}

fn assert_under_half(estimate: &CostEstimate, label: &str) {
    let resources = estimate.resources();
    assert!(
        (resources.instructions as u64) < TX_MAX_INSTRUCTIONS / 2,
        "{label}: must stay under 50% of tx_max_instructions ({TX_MAX_INSTRUCTIONS}); got {}",
        resources.instructions
    );
    assert!(
        (resources.write_bytes as u64) < TX_MAX_WRITE_BYTES / 2,
        "{label}: must stay under 50% of tx_max_write_bytes ({TX_MAX_WRITE_BYTES}); got {}",
        resources.write_bytes
    );
    assert!(
        (resources.disk_read_entries as u64) < TX_MAX_READ_LEDGER_ENTRIES as u64 / 2,
        "{label}: must stay under 50% of tx_max_disk_read_entries ({TX_MAX_READ_LEDGER_ENTRIES}); got {}",
        resources.disk_read_entries
    );
    assert!(
        (resources.write_entries as u64) < TX_MAX_WRITE_LEDGER_ENTRIES as u64 / 2,
        "{label}: must stay under 50% of tx_max_write_ledger_entries ({TX_MAX_WRITE_LEDGER_ENTRIES}); got {}",
        resources.write_entries
    );
}

#[test]
fn budget_propose_tier1_against_a_full_depeg_window() {
    let env = Env::default();
    let (client, oracle) = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    oracle.add_asset(&asset_config(&env, &asset, &issuer));
    client.register_definition(&depeg_definition(&asset));

    let keeper = Address::generate(&env);
    post_failing_depeg_window(&env, &oracle, &keeper, &asset);

    let caller = Address::generate(&env);
    client.propose_tier1(&caller, &asset, &EventKind::Depeg, &1);

    let estimate = env.cost_estimate();
    print_resources(
        "propose_tier1, Depeg, full 240 slot ring (72 window + 168 baseline)",
        &estimate,
    );
    assert_under_half(&estimate, "propose_tier1");
}

#[test]
fn budget_finalize_unchallenged_declares_against_a_full_depeg_window() {
    let env = Env::default();
    let (client, oracle) = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    oracle.add_asset(&asset_config(&env, &asset, &issuer));
    client.register_definition(&depeg_definition(&asset));

    let keeper = Address::generate(&env);
    post_failing_depeg_window(&env, &oracle, &keeper, &asset);
    let id = client.propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);

    // Push the cure window's own never-posted epochs past their own
    // backfill window, so finalize can decide (Declared) in this one
    // call: the worst case for finalize's own cure-check scan when
    // nobody ever posts a recovery.
    let now = env.ledger().timestamp();
    env.ledger()
        .set_timestamp(now + 86_400 + 259_200 + 7_200 + 1);
    client.finalize(&id);

    let estimate = env.cost_estimate();
    print_resources(
        "finalize, unchallenged Depeg, full cure-window scan to Declared",
        &estimate,
    );
    assert_under_half(&estimate, "finalize");
}

#[test]
fn budget_finalize_cure_against_a_full_challenge_window() {
    let env = Env::default();
    let (client, oracle) = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    oracle.add_asset(&asset_config(&env, &asset, &issuer));
    client.register_definition(&depeg_definition(&asset));

    let keeper = Address::generate(&env);
    post_failing_depeg_window(&env, &oracle, &keeper, &asset);
    let id = client.propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);
    let record = client.event(&id).unwrap();

    // Post every epoch in the cure window (worst case for the cure
    // scan: every epoch present and Final, not short-circuited by an
    // early missing epoch the way the Declared-by-default budget
    // test above is).
    let challenge_secs = 86_400u64;
    let first_cure_epoch = record.proposed_at / EPOCH_SECS;
    let last_cure_epoch = (record.proposed_at + challenge_secs) / EPOCH_SECS;
    for epoch in first_cure_epoch..last_cure_epoch {
        env.ledger().set_timestamp((epoch + 1) * EPOCH_SECS);
        oracle.post_signals(
            &keeper,
            &asset,
            &signal_set(&env, &keeper, epoch, 9_900_000),
        );
    }
    let now = record.proposed_at + challenge_secs;
    env.ledger()
        .set_timestamp(now.max(env.ledger().timestamp()) + 7_200 + 1);
    client.finalize(&id);

    let estimate = env.cost_estimate();
    print_resources(
        "finalize, Depeg cure, every epoch in a full 24h challenge window Final",
        &estimate,
    );
    assert_under_half(&estimate, "finalize (cure)");
}

/// PR #15 review, findings F2/F3: `challenge_secs` at its own new
/// upper bound (`MAX_CURE_EPOCHS`, 72 epochs), the largest cure-window
/// scan either `checkpoint_cure` or `finalize` can ever be asked to
/// do in this build.
fn depeg_definition_full_cure_window(asset: &Address) -> EventDefinition {
    let mut def = depeg_definition(asset);
    def.challenge_secs = 72 * EPOCH_SECS;
    def
}

#[test]
fn budget_checkpoint_cure_against_a_full_72_epoch_cure_window() {
    let env = Env::default();
    let (client, oracle) = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    oracle.add_asset(&asset_config(&env, &asset, &issuer));
    client.register_definition(&depeg_definition_full_cure_window(&asset));

    let keeper = Address::generate(&env);
    post_failing_depeg_window(&env, &oracle, &keeper, &asset);
    let id = client.propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);
    let record = client.event(&id).unwrap();

    // Post every epoch across the full 72-epoch cure window, above
    // cure_threshold: the worst case for checkpoint_cure's own scan,
    // every epoch newly decidable in a single call.
    let challenge_secs = 72 * EPOCH_SECS;
    let first_cure_epoch = record.proposed_at / EPOCH_SECS;
    let last_cure_epoch = (record.proposed_at + challenge_secs) / EPOCH_SECS;
    for epoch in first_cure_epoch..last_cure_epoch {
        env.ledger().set_timestamp((epoch + 1) * EPOCH_SECS);
        oracle.post_signals(
            &keeper,
            &asset,
            &signal_set(&env, &keeper, epoch, 9_900_000),
        );
    }
    let now = record.proposed_at + challenge_secs;
    env.ledger()
        .set_timestamp(now.max(env.ledger().timestamp()) + 7_200 + 1);

    client.checkpoint_cure(&id);

    let estimate = env.cost_estimate();
    print_resources(
        "checkpoint_cure, Depeg, every epoch across a full 72-epoch cure window newly decidable",
        &estimate,
    );
    assert_under_half(&estimate, "checkpoint_cure");
}

#[test]
fn budget_finalize_cure_against_a_full_72_epoch_cure_window() {
    let env = Env::default();
    let (client, oracle) = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    oracle.add_asset(&asset_config(&env, &asset, &issuer));
    client.register_definition(&depeg_definition_full_cure_window(&asset));

    let keeper = Address::generate(&env);
    post_failing_depeg_window(&env, &oracle, &keeper, &asset);
    let id = client.propose_tier1(&Address::generate(&env), &asset, &EventKind::Depeg, &1);
    let record = client.event(&id).unwrap();

    let challenge_secs = 72 * EPOCH_SECS;
    let first_cure_epoch = record.proposed_at / EPOCH_SECS;
    let last_cure_epoch = (record.proposed_at + challenge_secs) / EPOCH_SECS;
    for epoch in first_cure_epoch..last_cure_epoch {
        env.ledger().set_timestamp((epoch + 1) * EPOCH_SECS);
        oracle.post_signals(
            &keeper,
            &asset,
            &signal_set(&env, &keeper, epoch, 9_900_000),
        );
    }
    let now = record.proposed_at + challenge_secs;
    env.ledger()
        .set_timestamp(now.max(env.ledger().timestamp()) + 7_200 + 1);

    client.finalize(&id);

    let estimate = env.cost_estimate();
    print_resources(
        "finalize, Depeg cure, every epoch across a full 72-epoch cure window Final",
        &estimate,
    );
    assert_under_half(&estimate, "finalize (full cure window)");
}
