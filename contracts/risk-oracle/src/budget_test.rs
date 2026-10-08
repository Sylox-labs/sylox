//! Resource spike: measures `post_signals` and `score` (the real Tier 1
//! style read path, not a placeholder) against a FULL 240 slot ring
//! buffer, and prints the numbers against the current network limits.
//! See the PR description for the full report; this file is the source
//! of every number quoted there.
//!
//! Run with: `cargo test -p risk-oracle --lib budget -- --nocapture`

extern crate std;

use soroban_sdk::{
    testutils::{cost_estimate::CostEstimate, Address as _, Ledger as _},
    Address, BytesN, Env,
};
use std::println;
use sylox_types::{AssetConfig, EndpointStatus, IssuerActions, Reference, SignalSet};

use crate::mocks::MockStaking;
use crate::storage::RING_SLOTS;
use crate::{RiskOracle, RiskOracleClient};

fn asset_config(env: &Env, asset: &Address, issuer: &Address) -> AssetConfig {
    AssetConfig {
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
        redemption_net: 10_000_000_000,
        supply: 10_000_000_000_000,
        supply_change_bps: 0,
        issuer_actions: IssuerActions {
            clawbacks: 1,
            clawback_amount: 5_000_000_000,
            auth_revocations: 1,
            flag_changes: 0,
        },
        endpoint: EndpointStatus::Up,
        inputs_hash: BytesN::from_array(env, &[7u8; 32]),
        poster: Address::generate(env),
    }
}

/// Registers RiskOracle and a mock Staking, initializes RiskOracle
/// against it, and adds one enabled asset.
fn setup(env: &Env) -> (RiskOracleClient<'_>, Address) {
    env.mock_all_auths();
    let staking_id = env.register(MockStaking, ());
    let contract_id = env.register(RiskOracle, ());
    let client = RiskOracleClient::new(env, &contract_id);
    let governor = Address::generate(env);
    let registry = Address::generate(env);
    client.initialize(&governor, &registry, &staking_id);

    let asset = Address::generate(env);
    let issuer = Address::generate(env);
    client.add_asset(&asset_config(env, &asset, &issuer));

    (client, asset)
}

/// Fills the ring to `RING_SLOTS` consecutive epochs, 1 posting per call,
/// so the final posting measured below writes into a buffer that already
/// holds a full set of slots: the steady state every posting after startup
/// actually pays. Each posting uses a supply equal to the previous
/// epoch's, so the Section 11.3 supply-change consistency check (which
/// reads the previous epoch's ring slot) never rejects the fill. Returns
/// the next unused epoch.
fn warm_full_ring(env: &Env, client: &RiskOracleClient, asset: &Address) -> u64 {
    let keeper = Address::generate(env);
    for epoch in 0..RING_SLOTS as u64 {
        env.ledger().set_timestamp((epoch + 1) * 3_600);
        client.post_signals(&keeper, asset, &signal_set(env, epoch, 9_900_000));
    }
    RING_SLOTS as u64
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

#[test]
fn budget_post_signals_against_a_full_ring() {
    let env = Env::default();
    let (client, asset) = setup(&env);
    let next_epoch = warm_full_ring(&env, &client, &asset);

    // The measured call: ring is full, this posting evicts and replaces
    // exactly one slot, the steady state cost after the buffer has warmed.
    env.ledger().set_timestamp((next_epoch + 1) * 3_600);
    let keeper = Address::generate(&env);
    client.post_signals(&keeper, &asset, &signal_set(&env, next_epoch, 9_850_000));

    let estimate = env.cost_estimate();
    print_resources("post_signals, full 240 slot ring", &estimate);

    let resources = estimate.resources();
    assert!(
        resources.write_bytes < 65_536,
        "a single ring entry must fit under contract_data_entry_size_bytes (65,536); got {}",
        resources.write_bytes
    );
}

/// The real Tier 1 style read: `score(asset)`, which reads the 168 newest
/// ring slots via `storage::get_window` and computes all six Section 6.1
/// components, applies hysteresis and persists the result. This replaced
/// an earlier `#[cfg(test)]`-only placeholder method that approximated
/// the same aggregates without being a real, shipped function; now that
/// `score` exists for real, the budget test measures it directly instead.
#[test]
fn budget_score_against_a_full_ring() {
    let env = Env::default();
    let (client, asset) = setup(&env);
    warm_full_ring(&env, &client, &asset);

    let result = client.score(&asset);
    println!("computed: {result:?}");

    let estimate = env.cost_estimate();
    print_resources("score (Tier 1 style read), full 240 slot ring", &estimate);
}

/// Breaks the headline fee down by component. `fee()` uses a hardcoded
/// mainnet fee snapshot from 2026-07-10 (see its doc comment in
/// soroban-sdk), which may drift from the live network; this test exists
/// to show WHERE the fee goes, not to pin an exact total. See the PR
/// description for the quickstart-network simulated figure, which is the
/// number to trust over this one.
#[test]
fn budget_post_signals_fee_breakdown() {
    let env = Env::default();
    let (client, asset) = setup(&env);
    let next_epoch = warm_full_ring(&env, &client, &asset);

    env.ledger().set_timestamp((next_epoch + 1) * 3_600);
    let keeper = Address::generate(&env);
    client.post_signals(&keeper, &asset, &signal_set(&env, next_epoch, 9_850_000));

    let fee = env.cost_estimate().fee();
    println!("--- post_signals fee breakdown (stroops) ---");
    println!("  total:                 {}", fee.total);
    println!("  instructions:          {}", fee.instructions);
    println!("  disk_read_entries:     {}", fee.disk_read_entries);
    println!("  write_entries:         {}", fee.write_entries);
    println!("  disk_read_bytes:       {}", fee.disk_read_bytes);
    println!("  write_bytes:           {}", fee.write_bytes);
    println!("  contract_events:       {}", fee.contract_events);
    println!("  persistent_entry_rent: {}", fee.persistent_entry_rent);
    println!("  temporary_entry_rent:  {}", fee.temporary_entry_rent);

    // temporary_entry_rent dominates the total: see
    // budget_post_signals_rent_detail for why (the require_auth() nonce
    // entry's TTL bump, a temporary entry, not the ring or signals write).
}

/// Shows that the dominant fee component above is a `require_auth()` nonce
/// entry's rent, a temporary entry unrelated to the ring buffer or Signals
/// writes (both persistent). `persistent_entry_rent_bumps` stays at 1
/// because `Ring(asset)` is one entry rewritten every posting, not a new
/// entry each time.
#[test]
fn budget_post_signals_rent_detail() {
    let env = Env::default();
    let (client, asset) = setup(&env);
    let next_epoch = warm_full_ring(&env, &client, &asset);

    env.ledger().set_timestamp((next_epoch + 1) * 3_600);
    let keeper = Address::generate(&env);
    client.post_signals(&keeper, &asset, &signal_set(&env, next_epoch, 9_850_000));

    let resources = env.cost_estimate().resources();
    println!("--- post_signals rent detail ---");
    println!(
        "  persistent_rent_ledger_bytes: {}",
        resources.persistent_rent_ledger_bytes
    );
    println!(
        "  persistent_entry_rent_bumps:  {}",
        resources.persistent_entry_rent_bumps
    );
    println!(
        "  temporary_rent_ledger_bytes:  {}",
        resources.temporary_rent_ledger_bytes
    );
    println!(
        "  temporary_entry_rent_bumps:   {}",
        resources.temporary_entry_rent_bumps
    );
}
