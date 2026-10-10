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
    TX_MAX_FOOTPRINT_ENTRIES, TX_MAX_INSTRUCTIONS, TX_MAX_READ_LEDGER_ENTRIES, TX_MAX_WRITE_BYTES,
    TX_MAX_WRITE_LEDGER_ENTRIES, TX_MEMORY_LIMIT_BYTES,
};
use sylox_types::{
    AssetConfig, CoverGate, EndpointStatus, EventDefinition, EventKind, IssuerActions, IssuerFlags,
    Reference, SignalSet,
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

    pub fn lock_bond(
        _env: Env,
        _key: sylox_types::BondKey,
        _owner: Address,
        _amount: i128,
        _subject: Option<Address>,
    ) {
    }

    pub fn release_bond(_env: Env, _key: sylox_types::BondKey) {}

    pub fn forfeit_bond(_env: Env, _key: sylox_types::BondKey, _winner: Option<Address>) {}

    pub fn slash(
        _env: Env,
        _who: Address,
        _amount: i128,
        _winner: Option<Address>,
        _reason: BytesN<32>,
    ) {
    }

    pub fn reward_keeper(_env: Env, _keeper: Address, _epochs: u32) -> i128 {
        0
    }

    pub fn reward_keeper_sub_epochs(
        _env: Env,
        _keeper: Address,
        _sub_epoch_count: u32,
        _sub_epoch_secs: u64,
    ) -> i128 {
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

/// Minimal mock `Governor`, only what a sub-epoch dispute ruling
/// needs (`RiskOracle.resolve_sub_signal_dispute`'s own
/// `GovernorClient::committee()` call), matching `test.rs`'s own
/// `MockGovernor` convention. `setup` above never registers one,
/// since no other budget test here calls a committee-ruled path.
#[contract]
struct MockGovernor;

#[contractimpl]
impl MockGovernor {
    pub fn set_committee(env: Env, committee: Address) {
        env.storage()
            .instance()
            .set(&soroban_sdk::Symbol::new(&env, "committee"), &committee);
    }

    pub fn committee(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&soroban_sdk::Symbol::new(&env, "committee"))
            .unwrap()
    }
}

/// `setup`'s own sibling for the dispute-ruling tests: a real
/// `MockGovernor` contract in place of `setup`'s bare generated
/// address, since `resolve_sub_signal_dispute` makes a real
/// cross-contract call to it.
fn setup_with_governor(
    env: &Env,
) -> (
    EventRegistryClient<'_>,
    risk_oracle::RiskOracleClient<'_>,
    Address,
) {
    env.mock_all_auths();
    let governor = env.register(MockGovernor, ());
    let governor_client = MockGovernorClient::new(env, &governor);
    let committee = Address::generate(env);
    governor_client.set_committee(&committee);

    let staking = env.register(MockStaking, ());
    let oracle_id = env.register(risk_oracle::RiskOracle, ());
    let oracle = risk_oracle::RiskOracleClient::new(env, &oracle_id);
    let registry_id = env.register(EventRegistry, ());
    oracle.initialize(&governor, &registry_id, &staking);

    let factory = Address::generate(env);
    let usdc = Address::generate(env);
    let client = EventRegistryClient::new(env, &registry_id);
    client.initialize(&governor, &oracle_id, &staking, &factory, &usdc);

    (client, oracle, committee)
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
    println!("  footprint_entries:   {}", footprint_entries(estimate));
    println!("  fee.total (stroops): {}", fee.total);
}

/// Total DISTINCT ledger keys this call's own footprint touches
/// (read or written, each counted once): `disk_read_entries +
/// memory_read_entries + write_entries`, the exact sum
/// `soroban-env-host`'s own invocation metering checks against
/// `tx_max_footprint_entries` (confirmed by reading its source,
/// `invocation_metering.rs`'s own `total_ledger_entries` check; the
/// `CostEstimate` the test harness exposes has no single field named
/// this directly).
fn footprint_entries(estimate: &CostEstimate) -> u64 {
    let resources = estimate.resources();
    resources.disk_read_entries as u64
        + resources.memory_read_entries as u64
        + resources.write_entries as u64
}

fn assert_under_half(estimate: &CostEstimate, label: &str) {
    let resources = estimate.resources();
    assert!(
        (resources.instructions as u64) < TX_MAX_INSTRUCTIONS / 2,
        "{label}: must stay under 50% of tx_max_instructions ({TX_MAX_INSTRUCTIONS}); got {}",
        resources.instructions
    );
    assert!(
        (resources.mem_bytes as u64) < TX_MEMORY_LIMIT_BYTES / 2,
        "{label}: must stay under 50% of tx_memory_limit ({TX_MEMORY_LIMIT_BYTES}); got {}",
        resources.mem_bytes
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
    let footprint = footprint_entries(estimate);
    assert!(
        footprint < TX_MAX_FOOTPRINT_ENTRIES as u64 / 2,
        "{label}: must stay under 50% of tx_max_footprint_entries ({TX_MAX_FOOTPRINT_ENTRIES}); got {footprint}"
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

// -- Section 5.9 S5 (v1.5): cover_gate with sub-epoch reads --

fn sub_signal_set(env: &Env, keeper: &Address, hour: u64, peg_ratio: i128) -> SignalSet {
    SignalSet {
        epoch: hour,
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

/// `cover_gate`'s own worst case for its sub-epoch read (Section 5.9
/// S5, footprint-fix revision): the default Depeg window is 72 hours
/// (`DEFAULT_DEPEG_WINDOW_SECS` / `EPOCH_SECS`), and `depeg_check`
/// batches every unbuilt hour in that window into ONE
/// `RiskOracle.sub_peg_ratios_in_span_batch` cross-contract call
/// (touching exactly one ledger key, `Sub(asset)`, never `HeldHour`),
/// so the worst case is every one of the 72 hours still unbuilt at
/// once; one sub-epoch posted per hour is already enough. This is the
/// no-dispute companion to `budget_cover_gate_at_the_structural_cap_
/// every_hour_disputed` below: together they show the batched design
/// costs about the same whether or not every hour is under dispute.
#[test]
fn budget_cover_gate_against_72_unbuilt_hours_with_sub_epoch_reads() {
    let env = Env::default();
    let (client, oracle) = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    oracle.add_asset(&asset_config(&env, &asset, &issuer));
    // No definition registered: the Section 23 default window
    // (72h)/threshold applies, matching cover_gate_reports_recent_
    // depeg's own convention in test.rs.

    let keeper = Address::generate(&env);
    const SUB_EPOCH_SECS: u64 = 300;
    for hour in 0..72u64 {
        let sub_start = hour * EPOCH_SECS;
        env.ledger().set_timestamp(sub_start + SUB_EPOCH_SECS);
        oracle.post_sub_signals(
            &keeper,
            &asset,
            &hour,
            &0u32,
            &sub_signal_set(&env, &keeper, hour, 9_900_000),
        );
    }

    client.cover_gate(&asset);

    let estimate = env.cost_estimate();
    print_resources(
        "cover_gate, 72 unbuilt hours in the Depeg window, one sub-epoch read each",
        &estimate,
    );
    assert_under_half(&estimate, "cover_gate (72 unbuilt hours, sub-epoch reads)");
}

/// The structural maximum `depeg_check`'s own `unbuilt_hours` list can
/// ever reach in one `cover_gate` call: `RING_SLOTS (240) -
/// BASELINE_EPOCHS (168) = 72` epochs of window, plus the loop's own
/// inclusive upper bound, 73. `MAX_UNBUILT_HOURS_SCANNED_BY_COVER_GATE`
/// is set at exactly this structural ceiling (Section 15.3): every one
/// of the 73 hours ALSO disputed is this measurement's own worst case.
/// Since the footprint-fix review's Option 3 (`depeg_check` never
/// reads `HeldHour`), a disputed hour's own real roll-up (Option 1's
/// fix: a disputed sub-epoch excludes only itself, never its whole
/// hour) is read straight off `Ring(asset)`'s own provisional slot via
/// `provisional_sub_coverage`, the exact same one-key-per-call shape
/// as the no-dispute case (`budget_cover_gate_against_72_unbuilt_
/// hours_with_sub_epoch_reads`, above) — dispute or not makes no
/// difference to footprint at all, only `Sub(asset)`'s own one read.
#[test]
fn budget_cover_gate_at_the_structural_cap_every_hour_disputed() {
    let env = Env::default();
    let (client, oracle) = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    oracle.add_asset(&asset_config(&env, &asset, &issuer));
    let keeper = Address::generate(&env);
    let disputer = Address::generate(&env);
    for hour in 0..73u64 {
        let sub_start = hour * EPOCH_SECS;
        env.ledger().set_timestamp(sub_start + 300);
        oracle.post_sub_signals(
            &keeper,
            &asset,
            &hour,
            &0u32,
            &sub_signal_set(&env, &keeper, hour, 9_900_000),
        );
        oracle.dispute_sub_signals(
            &disputer,
            &asset,
            &hour,
            &0u32,
            &BytesN::from_array(&env, &[9u8; 32]),
        );
    }
    env.cost_estimate().budget().reset_unlimited();
    let result = client.cover_gate(&asset);
    assert_eq!(
        result,
        CoverGate::Clear,
        "73 disputed-but-healthy hours must not themselves read as a backlog or a depeg"
    );

    let estimate = env.cost_estimate();
    print_resources(
        "cover_gate, 73 unbuilt hours (the structural cap), every one disputed",
        &estimate,
    );
    assert_under_half(
        &estimate,
        "cover_gate (73 unbuilt hours, structural cap, every hour disputed)",
    );
}

/// Posts a single sub-epoch for `hour`s `0..count`, leaving every one
/// of those hours unbuilt (nothing crosses `SIGNAL_DISPUTE_SECS`),
/// then measures `cover_gate`. Shared by the 1-hour and 12-hour
/// measurements the redeploy report asks for, alongside the existing
/// 72 and 73 hour measurements above.
fn measure_cover_gate_with_n_unbuilt_hours(count: u64, label: &str) -> CostEstimate {
    let env = Env::default();
    let (client, oracle) = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    oracle.add_asset(&asset_config(&env, &asset, &issuer));
    let keeper = Address::generate(&env);
    for hour in 0..count {
        let sub_start = hour * EPOCH_SECS;
        env.ledger().set_timestamp(sub_start + 300);
        oracle.post_sub_signals(
            &keeper,
            &asset,
            &hour,
            &0u32,
            &sub_signal_set(&env, &keeper, hour, 9_900_000),
        );
    }
    env.cost_estimate().budget().reset_unlimited();
    let result = client.cover_gate(&asset);
    assert!(
        matches!(result, CoverGate::Clear),
        "{label}: {count} healthy unbuilt hours must read Clear, got {result:?}"
    );

    let estimate = env.cost_estimate();
    print_resources(label, &estimate);
    assert_under_half(&estimate, label);
    estimate
}

/// Report requirement: footprint, memory and instructions for
/// `cover_gate` at 1 and 12 unbuilt hours, alongside the existing 72
/// and 73 hour measurements (`budget_cover_gate_against_72_unbuilt_
/// hours_with_sub_epoch_reads`, `budget_cover_gate_at_the_structural_
/// cap_every_hour_disputed`).
#[test]
fn budget_cover_gate_against_1_and_12_unbuilt_hours() {
    measure_cover_gate_with_n_unbuilt_hours(1, "cover_gate, 1 unbuilt hour");
    measure_cover_gate_with_n_unbuilt_hours(12, "cover_gate, 12 unbuilt hours");
}

/// The footprint fix's own central claim: `cover_gate`'s footprint no
/// longer grows with how many hours are unbuilt, because the batched
/// in-span read (`sub_peg_ratios_in_span_batch`, one `Sub(asset)` key
/// total) and the out-of-span ring-provisional read (`Ring(asset)`'s
/// own slot, one key per hour the gate already reads regardless) both
/// touch a FIXED set of keys per hour, never `HeldHour`. Confirms this
/// directly: footprint at 1 unbuilt hour must equal footprint at 72.
#[test]
fn budget_cover_gate_footprint_is_constant_from_1_to_72_unbuilt_hours() {
    let at_1 =
        measure_cover_gate_with_n_unbuilt_hours(1, "cover_gate, 1 unbuilt hour (footprint check)");
    let at_72 = measure_cover_gate_with_n_unbuilt_hours(
        72,
        "cover_gate, 72 unbuilt hours (footprint check)",
    );
    assert_eq!(
        footprint_entries(&at_1),
        footprint_entries(&at_72),
        "footprint must stay the same whether 1 or 72 hours are unbuilt: the 400-entry limit \
         must not be something the unbuilt-hour cap has to work around"
    );
}

/// `depeg_check`'s own cap boundary, called directly (a sibling
/// module of `crate::depeg_check`, so this reaches the private
/// function the same way `cover_gate` does) because `UnbuiltBacklog`
/// is, by review finding, UNREACHABLE through the public API today:
/// `register_definition` caps `window_epochs` at `sylox_types::time::
/// MAX_DEPEG_WINDOW_EPOCHS` (72), so the inclusive scan it can ever
/// produce covers at most `MAX_UNBUILT_HOURS_SCANNED_BY_COVER_GATE`
/// (73) hours — exactly the cap, never past it, and the default
/// (no-definition) window is the same 72 epochs. `UnbuiltBacklog`
/// stays in `depeg_check` anyway as a defensive guard, failing closed
/// if `MAX_DEPEG_WINDOW_EPOCHS` and this cap are ever changed out of
/// step (the build-time assertion in `sylox_types::time` is the one
/// that actually prevents that, not this test), so this is the one
/// place that can still exercise it directly, with a constructed
/// `window_epochs` the public API itself can never produce: at
/// exactly `MAX_UNBUILT_HOURS_SCANNED_BY_COVER_GATE` unbuilt hours it
/// must still read Clear (the structural cap is not itself a
/// backlog), and at one more it must read `UnbuiltBacklog`, never
/// attempting the batched call at all.
#[test]
fn depeg_check_is_clear_at_the_cap_and_unbuilt_backlog_at_cap_plus_one() {
    use sylox_types::time::MAX_UNBUILT_HOURS_SCANNED_BY_COVER_GATE as CAP;

    let env = Env::default();
    let (_client, oracle) = setup(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    oracle.add_asset(&asset_config(&env, &asset, &issuer));
    let keeper = Address::generate(&env);

    // One hour past the cap: hours 0..=CAP, i.e. CAP + 1 hours total.
    for hour in 0..=(CAP as u64) {
        let sub_start = hour * EPOCH_SECS;
        env.ledger().set_timestamp(sub_start + 300);
        oracle.post_sub_signals(
            &keeper,
            &asset,
            &hour,
            &0u32,
            &sub_signal_set(&env, &keeper, hour, 9_900_000),
        );
    }

    let oracle_client = crate::clients::RiskOracleClient::new(&env, &oracle.address);
    let ring = oracle_client.ring(&asset);
    let newest_epoch = oracle_client.newest_epoch(&asset).unwrap();

    // At the cap: window_epochs = CAP - 1, so the inclusive scan
    // [newest_epoch - (CAP - 1), newest_epoch] covers exactly CAP hours.
    let at_cap = crate::depeg_check(
        &env,
        &oracle_client,
        &asset,
        &ring,
        newest_epoch,
        CAP - 1,
        9_500_000,
    );
    assert!(
        matches!(at_cap, crate::DepegCheck::Clear),
        "exactly {CAP} unbuilt healthy hours (the structural cap) must still read Clear"
    );

    // One past the cap: window_epochs = CAP, covering CAP + 1 hours.
    let at_cap_plus_one = crate::depeg_check(
        &env,
        &oracle_client,
        &asset,
        &ring,
        newest_epoch,
        CAP,
        9_500_000,
    );
    assert!(
        matches!(at_cap_plus_one, crate::DepegCheck::UnbuiltBacklog),
        "{} unbuilt hours, one past the cap, must read UnbuiltBacklog",
        CAP + 1
    );
}

/// A disputed sub-epoch inside the 5-hour `Sub(asset)` span is
/// excluded from `cover_gate`'s own read (R10's "Pending or Final"
/// wording, Disputed deliberately left out), and the ring's own
/// provisional roll-up (`waiting_hour`) agrees with the gate at every
/// step: a rejecting ruling (`keeper_wins: false`) keeps the
/// sub-epoch excluded permanently (it is cleared, never contributing
/// again, I23), while an upholding ruling (`keeper_wins: true`)
/// brings it back as a real, trusted value.
#[test]
fn disputed_sub_epoch_excluded_then_restored_or_cleared_by_ruling_matches_the_rollup() {
    let env = Env::default();
    let (client, oracle, _committee) = setup_with_governor(&env);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    oracle.add_asset(&asset_config(&env, &asset, &issuer));
    let keeper = Address::generate(&env);
    let disputer = Address::generate(&env);

    let hour = 100u64;
    // Two healthy sub-epochs, both near 1.0.
    env.ledger().set_timestamp(hour * EPOCH_SECS + 300);
    oracle.post_sub_signals(
        &keeper,
        &asset,
        &hour,
        &0u32,
        &sub_signal_set(&env, &keeper, hour, 9_900_000),
    );
    env.ledger().set_timestamp(hour * EPOCH_SECS + 300 + 300);
    oracle.post_sub_signals(
        &keeper,
        &asset,
        &hour,
        &1u32,
        &sub_signal_set(&env, &keeper, hour, 10_100_000),
    );
    // A third, genuinely depegged sub-epoch, immediately disputed.
    env.ledger()
        .set_timestamp(hour * EPOCH_SECS + 2 * 300 + 300);
    oracle.post_sub_signals(
        &keeper,
        &asset,
        &hour,
        &2u32,
        &sub_signal_set(&env, &keeper, hour, 9_000_000),
    );
    oracle.dispute_sub_signals(
        &disputer,
        &asset,
        &hour,
        &2u32,
        &BytesN::from_array(&env, &[9u8; 32]),
    );

    // While disputed: sub 2's depegged value must not surface through
    // either source. The gate must read Clear (sub 0 and 1 are
    // healthy, sub 2 is excluded), and the ring's own provisional
    // roll-up must agree: its mean comes from subs 0 and 1 alone.
    assert_eq!(
        client.cover_gate(&asset),
        CoverGate::Clear,
        "a disputed sub-epoch must be excluded from the gate's own read while the dispute is open"
    );
    let ring = oracle.ring(&asset);
    let slot = ring
        .iter()
        .find(|s| s.epoch == hour)
        .expect("a waiting hour with posted sub-epochs must have a ring slot");
    assert_eq!(
        slot.peg_ratio,
        (9_900_000 + 10_100_000) / 2,
        "the provisional roll-up must agree with the gate: the disputed sub-epoch excluded, \
         same as sub_peg_ratios"
    );

    // A ruling that rejects the keeper (keeper_wins: false): sub 2 is
    // cleared permanently, never contributing again.
    oracle.resolve_sub_signal_dispute(
        &asset,
        &hour,
        &2u32,
        &false,
        &BytesN::from_array(&env, &[1u8; 32]),
    );
    assert_eq!(
        client.cover_gate(&asset),
        CoverGate::Clear,
        "a rejected dispute must keep the sub-epoch excluded"
    );
    let ring = oracle.ring(&asset);
    let slot = ring.iter().find(|s| s.epoch == hour).unwrap();
    assert_eq!(
        slot.peg_ratio,
        (9_900_000 + 10_100_000) / 2,
        "the provisional roll-up must still agree with the gate after the rejection"
    );

    // Re-post sub 2, this time with the same depegged value, and have
    // the committee UPHOLD the keeper (keeper_wins: true): the
    // sub-epoch must come back as a real, trusted value, visible to
    // both the gate and the roll-up.
    env.ledger()
        .set_timestamp(hour * EPOCH_SECS + 2 * 300 + 300);
    oracle.post_sub_signals(
        &keeper,
        &asset,
        &hour,
        &2u32,
        &sub_signal_set(&env, &keeper, hour, 9_000_000),
    );
    oracle.dispute_sub_signals(
        &disputer,
        &asset,
        &hour,
        &2u32,
        &BytesN::from_array(&env, &[9u8; 32]),
    );
    oracle.resolve_sub_signal_dispute(
        &asset,
        &hour,
        &2u32,
        &true,
        &BytesN::from_array(&env, &[1u8; 32]),
    );
    assert_eq!(
        client.cover_gate(&asset),
        CoverGate::RecentDepeg,
        "an upheld dispute must bring the sub-epoch's real, depegged value back, now \
         visible to the gate"
    );
    let ring = oracle.ring(&asset);
    let slot = ring.iter().find(|s| s.epoch == hour).unwrap();
    assert_eq!(
        slot.peg_ratio,
        (9_900_000 + 10_100_000 + 9_000_000) / 3,
        "the provisional roll-up must agree with the gate: the upheld sub-epoch is back"
    );
}
