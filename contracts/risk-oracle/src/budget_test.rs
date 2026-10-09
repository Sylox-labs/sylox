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

/// Review item C6 (re-review): the worst case for `try_advance_finality`'s
/// backward scan combines a FULL 240 slot ring (the realistic storage
/// read/write cost every posting already pays, see
/// `budget_post_signals_against_a_full_ring`) with a long run of
/// MISSING epochs between the newest Final epoch and the newest
/// posted one, forcing the scan to walk every epoch in its lookback
/// bound (`WINDOW_SECS / EPOCH_SECS`, 72) without finding anything,
/// rather than the common case (1-2 epochs back, given the 2 epoch
/// finality lag) terminating almost immediately.
///
/// Warms a full ring normally, then posts one more epoch, skips the
/// next 71 entirely (never posted), then posts the epoch 72 slots
/// later (the oldest epoch `check_epoch_window` still accepts relative
/// to that posting time) and measures THAT call, whose
/// `try_advance_finality` sweep must walk the full 71 epoch gap
/// before finding the epoch just before it Final.
#[test]
fn budget_finality_backward_scan_across_a_full_backfill_window() {
    let env = Env::default();
    let (client, asset) = setup(&env);
    let next_epoch = warm_full_ring(&env, &client, &asset);
    let keeper = Address::generate(&env);

    env.ledger().set_timestamp((next_epoch + 1) * 3_600);
    client.post_signals(&keeper, &asset, &signal_set(&env, next_epoch, 9_900_000));
    // The next 71 epochs intentionally never posted.
    let gap_start = next_epoch + 1;
    let resume_epoch = gap_start + 71;

    env.ledger().set_timestamp((resume_epoch + 1) * 3_600);
    client.post_signals(&keeper, &asset, &signal_set(&env, resume_epoch, 9_900_000));

    // Capture the estimate for THIS post_signals call immediately,
    // before any further invocation (including the sanity check read
    // below) can fold its own cost into cost_estimate()'s result.
    let estimate = env.cost_estimate();
    print_resources(
        "post_signals, full ring, try_advance_finality scanning a 71 epoch missing gap",
        &estimate,
    );

    // Sanity check, AFTER capturing the estimate above: resume_epoch
    // itself cannot be Final yet (posted this instant, pending_until
    // is in the future). next_epoch's own pending_until is also 2
    // epochs ahead of its own post time (SIGNAL_DISPUTE_SECS), so the
    // newest epoch actually Final by the time resume_epoch posts is
    // next_epoch - 2 (the same finality lag every other test in this
    // crate accounts for), reached only by walking back across nearly
    // the entire gap, not a trivial same-epoch or 1-step result.
    assert_eq!(
        client.score(&asset).epoch,
        next_epoch - 2,
        "the measured call's backward scan must walk nearly the full 71 epoch gap, \
         not stop early; a different result here means this test is not actually \
         measuring the scenario it claims to"
    );

    let resources = estimate.resources();
    assert!(
        resources.instructions < 400_000_000,
        "must stay comfortably under tx_max_instructions even at this scan's worst case; got {}",
        resources.instructions
    );
}

/// Issue #11 fix (feat/treasury): the worst case for
/// `reward_posters_for_newly_final_epochs` is a FULL backfill window
/// (`FINALITY_LOOKBACK_EPOCHS`, 73 at the defaults) becoming Final in
/// one call, posted by SEVERAL different keepers rotating through
/// the window, so the grouping step's `Map` holds as many distinct
/// posters as the scenario allows and the single measured call must
/// both scan the whole window AND issue one `reward_keeper` cross
/// contract call per distinct poster found in it, not just walk past
/// a long missing gap the way
/// `budget_finality_backward_scan_across_a_full_backfill_window`
/// measures.
///
/// Builds this by posting `FINALITY_LOOKBACK_EPOCHS` consecutive
/// epochs in quick succession (each one still Pending, none yet
/// observed Final: every post lands well inside the previous
/// posts' own `SIGNAL_DISPUTE_SECS` windows), rotating through 5
/// keepers round robin, then waiting out the dispute window and
/// making ONE further call whose finality sweep observes the entire
/// run as newly Final at once.
#[test]
fn budget_reward_keeper_grouping_across_a_full_backfill_window_several_keepers() {
    let env = Env::default();
    env.mock_all_auths();
    let staking = env.register(MockStaking, ());
    let contract_id = env.register(RiskOracle, ());
    let client = RiskOracleClient::new(&env, &contract_id);
    let governor = Address::generate(&env);
    let registry = Address::generate(&env);
    client.initialize(&governor, &registry, &staking);
    let asset = Address::generate(&env);
    let issuer = Address::generate(&env);
    client.add_asset(&asset_config(&env, &asset, &issuer));

    const KEEPER_COUNT: usize = 5;
    let keepers: std::vec::Vec<Address> =
        (0..KEEPER_COUNT).map(|_| Address::generate(&env)).collect();

    // `lookback - 1` epochs, posted in a backfill (every post at the
    // SAME fixed `now`, each posting an older epoch than the
    // contract's own notion of "current"), so NONE of them can
    // become Final during this loop: pending_until is always
    // `now + SIGNAL_DISPUTE_SECS`, strictly in the future relative to
    // this same, unmoving `now`, regardless of how many of these
    // backfill posts happen first. This is the key difference from
    // posting them one real epoch apart (which, tried first, found a
    // genuine timing coincidence: EPOCH_SECS * 2 lands exactly on
    // SIGNAL_DISPUTE_SECS at the defaults, so epochs kept crossing
    // into Final mid-loop instead of staying Pending for this test's
    // own final, single sweep).
    let lookback = crate::FINALITY_LOOKBACK_EPOCHS as u64;
    let backfill_count = lookback - 1;
    let now = backfill_count * 3_600 + 3_600;
    env.ledger().set_timestamp(now);
    for epoch in 0..backfill_count {
        let keeper = &keepers[epoch as usize % KEEPER_COUNT];
        client.post_signals(keeper, &asset, &signal_set(&env, epoch, 9_900_000));
    }

    // One more post, far enough past the window's own dispute delay
    // that the entire backfilled run above crosses into Final during
    // THIS call's own finality sweep. The test harness's own default
    // CPU/memory budget (100M instructions, 40MB) is well below the
    // real network's tx_max_instructions (400M) asserted below, and
    // this one call — finalizing 72 epochs AND fanning out 5
    // cross-contract reward_keeper calls — is heavy enough to hit
    // that harness default before ever reaching the real limit this
    // test exists to check against. Lift it so the call measures
    // against the real ceiling instead of panicking on the harness's
    // conservative one.
    env.cost_estimate().budget().reset_unlimited();
    let final_epoch = backfill_count;
    env.ledger()
        .set_timestamp((final_epoch + 1) * 3_600 + crate::SIGNAL_DISPUTE_SECS);
    client.post_signals(
        &keepers[0],
        &asset,
        &signal_set(&env, final_epoch, 9_900_000),
    );

    let estimate = env.cost_estimate();
    print_resources(
        "post_signals, full backfill window (73 epochs) crossing into Final in one call, 5 keepers",
        &estimate,
    );

    // Sanity check this test actually measures what it claims: all 5
    // keepers must have been rewarded by this one call (one
    // reward_keeper call per distinct poster, grouped), not 0 and not
    // partially.
    let staking_client = crate::mocks::MockStakingClient::new(&env, &staking);
    for keeper in &keepers {
        assert!(
            staking_client.reward_keeper_epochs(keeper) > 0,
            "every one of the 5 rotating keepers must have been rewarded by this call"
        );
    }
    assert_eq!(
        staking_client.call_count(&soroban_sdk::Symbol::new(&env, "reward_keeper")),
        KEEPER_COUNT as u32,
        "exactly one reward_keeper call per distinct poster, not one per epoch"
    );

    let resources = estimate.resources();
    assert!(
        resources.instructions < 400_000_000,
        "must stay comfortably under tx_max_instructions even with every keeper in the \
         window rewarded in one call; got {}",
        resources.instructions
    );
    assert!(
        resources.write_bytes < 132_096,
        "must stay comfortably under tx_max_write_bytes; got {}",
        resources.write_bytes
    );
}
