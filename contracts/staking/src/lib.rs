#![no_std]

//! Staking: keeper bonds, reporter stakes and probes, signal dispute
//! bonds, event proposal and challenge bonds; executes slashing on
//! instruction from RiskOracle and EventRegistry. technical-doc.md
//! Section 7, 12.3, ADR-004.
//!
//! Scope (feat/staking): `Treasury`, `EventRegistry`, `MarketFactory`,
//! `Series` and `Governor` are not implemented here. Where this
//! contract needs them, it uses the address passed at `initialize`
//! (checked via `require_auth()` on calls FROM them) and mocks in
//! tests stand in for calls made ON them (`EventRegistry`'s bond
//! calls). `reward_keeper`/`fund_rewards`/`claim_rewards` hold reward
//! balances in this contract directly rather than routing them
//! through `Treasury.accrue_reward` (Section 7.5), a stand-in for
//! until `Treasury` exists; see the PR's "Spec deviations" section.
//!
//! Accounting invariants (task brief), tested in `test::property`
//! and noted again at each function below that could threaten them:
//!
//! S1. USDC balance of this contract >= total keeper bonds + total
//!     reporter stake + total locked bonds + unclaimed `claimable` +
//!     the unallocated `RewardPool` balance. Every function that
//!     moves USDC (`stake`, `unstake`, `withdraw_keeper_bond`,
//!     `lock_bond`, `release_bond`/`forfeit_bond`'s `claimable`
//!     credit, `slash`, `fund_rewards`, `settle_probes`'s reward
//!     accrual, `claim`/`claim_rewards`) keeps this contract's own
//!     real balance and its tracked liabilities moving together,
//!     never letting a liability grow without the matching transfer
//!     in, or a transfer out exceed what was tracked.
//! S2. A bond (`storage::BondRecord`, keyed by `BondKey`) is either
//!     Locked (present in storage), Released or Forfeited (absent,
//!     its value moved to `claimable`); `lock_bond` rejects a key
//!     that already exists (`BondExists`), and `release_bond`/
//!     `forfeit_bond` both clear the record before crediting
//!     anything, so the same key can satisfy at most one of them.
//! S3. No function here moves a participant's stake or bond to any
//!     address other than that participant itself (`unstake`,
//!     `withdraw_keeper_bond`, `claim`, `claim_rewards`), a named
//!     dispute winner (`forfeit_bond`'s `winner`, `slash`'s
//!     `winner`), or `config.treasury` (the other half of every
//!     `forfeit_bond`/`slash` split, and the whole amount when no
//!     winner is named). No function here takes an arbitrary
//!     destination address as a parameter.
//! S4. `aggregate` never writes: it and the pure `aggregation`
//!     module it calls take only already-read data and return a
//!     computed status, with no call to any storage write function
//!     anywhere in that path.

mod aggregation;
mod error;
mod events;
mod params;
mod storage;

use soroban_sdk::{contract, contractimpl, token, Address, BytesN, Env, Symbol, Vec};
use sylox_types::{BondKey, EndpointStatus, KeeperInfo, ProbeReport, ReporterInfo};

use error::Error;
use storage::{BondRecord, StoredProbe};

#[contract]
pub struct Staking;

#[derive(Clone)]
#[soroban_sdk::contracttype]
struct Config {
    governor: Address,
    oracle: Address,
    registry: Address,
    treasury: Address,
    usdc: Address,
}

const CONFIG_KEY: Symbol = soroban_sdk::symbol_short!("CONFIG");

/// Section 7.8's 50/50 split, rounding the remainder (if `amount` is
/// odd) to the treasury side rather than the winner's, so the two
/// halves always sum back to exactly `amount` with no dust.
fn split_half(amount: i128) -> (i128, i128) {
    let to_winner = amount / 2;
    let to_treasury = amount - to_winner;
    (to_winner, to_treasury)
}

#[contractimpl]
impl Staking {
    pub fn initialize(
        env: Env,
        governor: Address,
        oracle: Address,
        registry: Address,
        treasury: Address,
        usdc: Address,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&CONFIG_KEY) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(
            &CONFIG_KEY,
            &Config {
                governor,
                oracle,
                registry,
                treasury,
                usdc,
            },
        );
        Ok(())
    }

    // -- membership (Section 7.6, 7.7, 12.3) --

    pub fn add_keeper(env: Env, keeper: Address) -> Result<(), Error> {
        let config = Self::require_config(&env)?;
        config.governor.require_auth();
        if storage::get_keeper(&env, &keeper).is_some() {
            return Err(Error::AlreadyRegistered);
        }
        if storage::get_reporter(&env, &keeper).is_some() {
            // Review fix S6: one role per address, so slash (and
            // every other keeper-or-reporter branch) always has
            // exactly one target.
            return Err(Error::RoleConflict);
        }
        storage::set_keeper(
            &env,
            &keeper,
            &KeeperInfo {
                bond: 0,
                fault_times: Vec::new(&env),
                suspended: false,
                unstake_requested_at: None,
                removed_at: None,
                open_dispute_count: 0,
            },
        );
        Ok(())
    }

    /// Deactivates the keeper immediately (Section 7.7's `Staked ->
    /// Suspended`-style exit; `is_active_keeper` reads `false` from
    /// this point on, so `RiskOracle.post_signals` rejects it). Does
    /// NOT release the bond: `withdraw_keeper_bond` does that, once
    /// `KEEPER_EXIT_DELAY_SECS` has passed AND every signal dispute
    /// naming this keeper has resolved (lead decision, feat/staking:
    /// removal is not an escape hatch from an open dispute).
    pub fn remove_keeper(env: Env, keeper: Address) -> Result<(), Error> {
        let config = Self::require_config(&env)?;
        config.governor.require_auth();
        let mut info = storage::get_keeper(&env, &keeper).ok_or(Error::NotKeeper)?;
        let now = env.ledger().timestamp();
        info.removed_at = Some(now);
        storage::set_keeper(&env, &keeper, &info);
        events::KeeperRemoved {
            keeper: keeper.clone(),
            removed_at: now,
            withdrawable_at: now + params::KEEPER_EXIT_DELAY_SECS,
        }
        .publish(&env);
        Ok(())
    }

    pub fn add_reporter(env: Env, reporter: Address, region: Symbol) -> Result<(), Error> {
        let config = Self::require_config(&env)?;
        config.governor.require_auth();
        if storage::get_reporter(&env, &reporter).is_some() {
            return Err(Error::AlreadyRegistered);
        }
        if storage::get_keeper(&env, &reporter).is_some() {
            // Review fix S6: see add_keeper's own check above.
            return Err(Error::RoleConflict);
        }
        storage::set_reporter(
            &env,
            &reporter,
            &ReporterInfo {
                stake: 0,
                region,
                fault_times: Vec::new(&env),
                suspended: false,
                unstake_requested_at: None,
                removed_at: None,
            },
        );
        storage::add_to_all_reporters(&env, &reporter);
        Ok(())
    }

    /// Deactivates the reporter immediately (no new `submit_probe`).
    /// Does NOT release the stake: it stays locked, and slashable,
    /// until `REPORTER_EXIT_DELAY_SECS` after removal (lead decision,
    /// feat/staking), via the same `unstake` path a voluntary exit
    /// uses, since `unstake` already checks `removed_at` when present
    /// (see `unstake` below).
    pub fn remove_reporter(env: Env, reporter: Address) -> Result<(), Error> {
        let config = Self::require_config(&env)?;
        config.governor.require_auth();
        let mut info = storage::get_reporter(&env, &reporter).ok_or(Error::NotReporter)?;
        let now = env.ledger().timestamp();
        info.removed_at = Some(now);
        storage::set_reporter(&env, &reporter, &info);
        events::ReporterRemoved {
            reporter: reporter.clone(),
            removed_at: now,
            withdrawable_at: now + params::REPORTER_EXIT_DELAY_SECS,
        }
        .publish(&env);
        Ok(())
    }

    // -- keeper bonds and reporter stakes (Section 12.3) --

    pub fn stake(env: Env, who: Address, amount: i128) -> Result<(), Error> {
        who.require_auth();
        if amount <= 0 {
            return Err(Error::StakeTooLow);
        }
        let config = Self::require_config(&env)?;
        let usdc = token::TokenClient::new(&env, &config.usdc);
        let here = env.current_contract_address();

        if let Some(mut keeper) = storage::get_keeper(&env, &who) {
            if keeper.removed_at.is_some() {
                return Err(Error::NotKeeper);
            }
            usdc.transfer(&who, soroban_sdk::MuxedAddress::from(here.clone()), &amount);
            keeper.bond = keeper.bond.checked_add(amount).ok_or(Error::MathOverflow)?;
            storage::set_keeper(&env, &who, &keeper);
            events::Staked {
                who: who.clone(),
                amount,
                total_after: keeper.bond,
            }
            .publish(&env);
            return Ok(());
        }
        if let Some(mut reporter) = storage::get_reporter(&env, &who) {
            if reporter.removed_at.is_some() {
                return Err(Error::NotReporter);
            }
            usdc.transfer(&who, soroban_sdk::MuxedAddress::from(here.clone()), &amount);
            reporter.stake = reporter
                .stake
                .checked_add(amount)
                .ok_or(Error::MathOverflow)?;
            storage::set_reporter(&env, &who, &reporter);
            events::Staked {
                who: who.clone(),
                amount,
                total_after: reporter.stake,
            }
            .publish(&env);
            return Ok(());
        }
        Err(Error::NotKeeper)
    }

    /// Starts the voluntary unstake cooldown for `amount` of `who`'s
    /// bond or stake. v1 has no partial unstake tracking beyond this:
    /// a second `unstake_request` while one is already pending is
    /// rejected (`UnstakePending`), matching Section 12.3's "starts
    /// cooldown" being a one-shot action per cycle.
    pub fn unstake_request(env: Env, who: Address, amount: i128) -> Result<(), Error> {
        who.require_auth();
        if amount <= 0 {
            return Err(Error::StakeTooLow);
        }
        Self::require_config(&env)?;
        let now = env.ledger().timestamp();

        if let Some(mut keeper) = storage::get_keeper(&env, &who) {
            if keeper.unstake_requested_at.is_some() {
                return Err(Error::UnstakePending);
            }
            if amount > keeper.bond {
                return Err(Error::StakeTooLow);
            }
            keeper.unstake_requested_at = Some(now);
            storage::set_keeper(&env, &who, &keeper);
            return Ok(());
        }
        if let Some(mut reporter) = storage::get_reporter(&env, &who) {
            if reporter.unstake_requested_at.is_some() {
                return Err(Error::UnstakePending);
            }
            if amount > reporter.stake {
                return Err(Error::StakeTooLow);
            }
            reporter.unstake_requested_at = Some(now);
            storage::set_reporter(&env, &who, &reporter);
            return Ok(());
        }
        Err(Error::NotKeeper)
    }

    /// Pays out `who`'s full bond or stake after its cooldown
    /// (voluntary, `UNSTAKE_COOLDOWN_SECS`, or removal triggered,
    /// `KEEPER_EXIT_DELAY_SECS`/`REPORTER_EXIT_DELAY_SECS`: whichever
    /// applies). A keeper's own open dispute count must also be zero
    /// (lead decision, feat/staking); `withdraw_keeper_bond` is the
    /// dedicated entry point for the removal path's own extra check,
    /// but a VOLUNTARY `unstake` (not preceded by `remove_keeper`)
    /// still goes through this function, so it also checks
    /// `open_dispute_count` here, not only there.
    pub fn unstake(env: Env, who: Address) -> Result<i128, Error> {
        who.require_auth();
        let config = Self::require_config(&env)?;
        let now = env.ledger().timestamp();
        let here = env.current_contract_address();
        let usdc = token::TokenClient::new(&env, &config.usdc);

        if let Some(mut keeper) = storage::get_keeper(&env, &who) {
            let requested_at = keeper
                .unstake_requested_at
                .ok_or(Error::NoUnstakeRequested)?;
            if now < requested_at + params::UNSTAKE_COOLDOWN_SECS {
                return Err(Error::UnstakeCooldown);
            }
            if keeper.open_dispute_count > 0 {
                // Review fix S7: a dedicated code, distinct from
                // Suspended (a fault/evidence outcome). This keeper
                // is not suspended; its funds are still needed as
                // collateral for an open dispute.
                return Err(Error::DisputesOpen);
            }
            let amount = keeper.bond;
            keeper.bond = 0;
            keeper.unstake_requested_at = None;
            storage::set_keeper(&env, &who, &keeper);
            if amount > 0 {
                usdc.transfer(&here, soroban_sdk::MuxedAddress::from(who.clone()), &amount);
            }
            events::Unstaked {
                who: who.clone(),
                amount,
                total_after: 0,
            }
            .publish(&env);
            return Ok(amount);
        }
        if let Some(mut reporter) = storage::get_reporter(&env, &who) {
            let requested_at = reporter
                .unstake_requested_at
                .ok_or(Error::NoUnstakeRequested)?;
            if now < requested_at + params::UNSTAKE_COOLDOWN_SECS {
                return Err(Error::UnstakeCooldown);
            }
            let amount = reporter.stake;
            reporter.stake = 0;
            reporter.unstake_requested_at = None;
            storage::set_reporter(&env, &who, &reporter);
            if amount > 0 {
                usdc.transfer(&here, soroban_sdk::MuxedAddress::from(who.clone()), &amount);
            }
            events::Unstaked {
                who: who.clone(),
                amount,
                total_after: 0,
            }
            .publish(&env);
            return Ok(amount);
        }
        Err(Error::NotKeeper)
    }

    /// The removal triggered exit path (lead decision, feat/staking):
    /// permissionless, pays a removed keeper's bond (less any
    /// slashes already applied to it) back to the keeper once BOTH
    /// `now >= removed_at + KEEPER_EXIT_DELAY_SECS` (every posting's
    /// dispute window has closed) and `open_dispute_count == 0`
    /// (nothing still open could slash it) hold. Distinct from
    /// `unstake`, which is the keeper's OWN voluntary exit while still
    /// registered; this is governor initiated removal's exit, with no
    /// `unstake_request` step since `remove_keeper` already started
    /// its own clock.
    pub fn withdraw_keeper_bond(env: Env, keeper: Address) -> Result<i128, Error> {
        let config = Self::require_config(&env)?;
        let mut info = storage::get_keeper(&env, &keeper).ok_or(Error::NotKeeper)?;
        let removed_at = info.removed_at.ok_or(Error::NotKeeper)?;
        let now = env.ledger().timestamp();
        if now < removed_at + params::KEEPER_EXIT_DELAY_SECS {
            return Err(Error::UnstakeCooldown);
        }
        if info.open_dispute_count > 0 {
            // Review fix S7: see unstake's own comment above.
            return Err(Error::DisputesOpen);
        }
        let amount = info.bond;
        info.bond = 0;
        storage::set_keeper(&env, &keeper, &info);
        if amount > 0 {
            let usdc = token::TokenClient::new(&env, &config.usdc);
            usdc.transfer(
                &env.current_contract_address(),
                soroban_sdk::MuxedAddress::from(keeper.clone()),
                &amount,
            );
        }
        events::KeeperBondWithdrawn {
            keeper: keeper.clone(),
            amount,
        }
        .publish(&env);
        Ok(amount)
    }

    // -- probes (Section 7.3) --

    /// technical-doc.md Section 7.3: one report per reporter per asset
    /// per epoch. The report's own `region` field is ignored (Section
    /// 7.3's field notes this build makes concrete): the reporter's
    /// REGISTERED region is snapshotted into storage at submission
    /// time instead (lead decision, feat/staking), so `aggregate`/
    /// `settle_probes` never need a live registration lookup.
    ///
    /// Accepted only for the current epoch or the just closed epoch,
    /// within `PROBE_GRACE_SECS` of its close (new parameter,
    /// feat/staking; Section 7.3 called for a grace period without
    /// naming one). Every probe write extends its own TTL, and the
    /// (asset, epoch) submitter index's TTL, to `PROBE_TTL_LEDGERS`,
    /// which the `params_test` module proves covers the full
    /// settlement window with margin.
    pub fn submit_probe(env: Env, reporter: Address, report: ProbeReport) -> Result<(), Error> {
        reporter.require_auth();
        Self::require_config(&env)?;
        let info = storage::get_reporter(&env, &reporter).ok_or(Error::NotReporter)?;
        if info.suspended || info.removed_at.is_some() {
            return Err(Error::Suspended);
        }
        if info.stake < params::REPORTER_STAKE {
            // Section 7.7: "below reporter_stake is not active." Not
            // `Suspended` (that is a fault/evidence outcome, a
            // distinct reason); `StakeTooLow` is the code
            // `stake`/`unstake_request` already use for the same
            // underlying condition.
            return Err(Error::StakeTooLow);
        }

        let now = env.ledger().timestamp();
        let current_epoch = now / params::EPOCH_SECS;
        let epoch_close = (report.epoch + 1) * params::EPOCH_SECS;
        let is_current = report.epoch == current_epoch;
        let is_just_closed_within_grace =
            report.epoch + 1 == current_epoch || now <= epoch_close + params::PROBE_GRACE_SECS;
        if !is_current && !is_just_closed_within_grace {
            return Err(Error::ProbeWindowClosed);
        }

        if storage::get_probe(&env, &report.asset, report.epoch, &reporter).is_some() {
            return Err(Error::DuplicateProbe);
        }

        let stored = StoredProbe {
            report: report.clone(),
            region_at_submission: info.region.clone(),
        };
        storage::set_probe(
            &env,
            &report.asset,
            report.epoch,
            &reporter,
            &stored,
            params::PROBE_TTL_LEDGERS,
        );
        let added = storage::add_submitter(
            &env,
            &report.asset,
            report.epoch,
            &reporter,
            params::MAX_SUBMITTERS_PER_EPOCH,
            params::PROBE_TTL_LEDGERS,
        );
        if !added {
            // MAX_SUBMITTERS_PER_EPOCH reached (DuplicateProbe already
            // ruled out above): refuse rather than silently excluding
            // this reporter from the aggregate it just paid gas to
            // submit into.
            return Err(Error::ProbeWindowClosed);
        }

        events::ProbeSubmitted {
            asset: report.asset.clone(),
            reporter,
            epoch: report.epoch,
            status: report.status,
            region: info.region,
        }
        .publish(&env);
        Ok(())
    }

    /// technical-doc.md Section 7.4. A READ with no side effects (S4):
    /// never calls any storage write, directly or through
    /// `aggregation::compute`, which is itself pure. Uses the
    /// submitter index, never the live reporter set (lead decision,
    /// feat/staking), so a removed reporter's already submitted probe
    /// still counts here exactly as it would have before removal.
    pub fn aggregate(env: Env, asset: Address, epoch: u64) -> EndpointStatus {
        let (_, reports) = Self::collect_reports(&env, &asset, epoch);
        aggregation::compute(&env, &reports)
    }

    /// Reads every still present probe for (asset, epoch) via the
    /// submitter index (lead decision, feat/staking: never the live
    /// reporter set). Returns the reporter addresses and their
    /// `StoredProbe`s as two parallel vectors (same index in each),
    /// rather than a single `Vec` of pairs, since `aggregation`'s pure
    /// functions only ever need the probes, not who submitted them.
    fn collect_reports(env: &Env, asset: &Address, epoch: u64) -> (Vec<Address>, Vec<StoredProbe>) {
        let submitters = storage::get_submitters(env, asset, epoch);
        let mut addresses = Vec::new(env);
        let mut reports = Vec::new(env);
        for reporter in submitters.iter() {
            if let Some(probe) = storage::get_probe(env, asset, epoch, &reporter) {
                addresses.push_back(reporter);
                reports.push_back(probe);
            }
        }
        (addresses, reports)
    }

    /// technical-doc.md Section 7.4, 7.5, 12.3 (named `settle_probes`
    /// there and in the `RiskOracle` client this exact signature must
    /// match; the task's own notes call the same function
    /// `settle_epoch`, but `RiskOracle.finalize_endpoint` already
    /// calls `Staking.settle_probes` by that name, so this build keeps
    /// the name `RiskOracle` depends on).
    ///
    /// Lead decision (settlement window): permissionless, callable
    /// exactly once per (asset, epoch), and ONLY while every probe for
    /// that epoch is guaranteed to still exist: not before
    /// `PROBE_GRACE_SECS` has elapsed since the epoch closed
    /// (`SettlementNotOpen`), and not after `SETTLE_WINDOW_SECS` more
    /// has elapsed on top of that (`SettlementWindowExpired`). An
    /// epoch nobody settles within its window simply never settles:
    /// no faults, no rewards, nothing reserved for it, the reward pool
    /// untouched; this is the intended behavior (see the PR report),
    /// not an error state, because settling on a set of probes that
    /// cannot be guaranteed complete would let an attacker who can
    /// extend their OWN probe's TTL (any address can call
    /// `extend_ttl`-backed functions on data they do not own, the
    /// write just failed to re-extend another entry, not inspect
    /// one) manufacture a majority by letting everyone else's probe
    /// expire first.
    pub fn settle_probes(env: Env, asset: Address, epoch: u64) -> Result<(), Error> {
        let config = Self::require_config(&env)?;
        if storage::get_probes_settled(&env, &asset, epoch) {
            return Err(Error::AlreadySettled);
        }

        let now = env.ledger().timestamp();
        let epoch_close = (epoch + 1) * params::EPOCH_SECS;
        let window_opens = epoch_close + params::PROBE_GRACE_SECS;
        let window_closes = window_opens + params::SETTLE_WINDOW_SECS;
        if now < window_opens {
            return Err(Error::SettlementNotOpen);
        }
        if now > window_closes {
            return Err(Error::SettlementWindowExpired);
        }

        let (addresses, reports) = Self::collect_reports(&env, &asset, epoch);
        let aggregate = aggregation::compute(&env, &reports);
        let majority_size = aggregation::majority_size(&reports, aggregate);

        let mut rewarded: u32 = 0;
        let mut faulted: u32 = 0;
        let per_reporter_reward = if majority_size > 0 {
            params::REPORTER_REWARD_PER_EPOCH / majority_size as i128
        } else {
            0
        };

        for i in 0..reports.len() {
            let stored = reports.get(i).unwrap();
            let reporter = addresses.get(i).unwrap();
            let matched = stored.report.status == aggregate;
            if matched {
                if majority_size > 0 && per_reporter_reward > 0 {
                    Self::accrue_reward_capped(&env, &reporter, per_reporter_reward);
                }
                rewarded += 1;
            } else if majority_size >= params::FAULT_MAJORITY_THRESHOLD {
                Self::record_fault(&env, &reporter, now, &config.treasury);
                faulted += 1;
            }
        }

        storage::set_probes_settled(&env, &asset, epoch, params::PROBE_TTL_LEDGERS);
        events::ProbesSettled {
            asset,
            epoch,
            aggregate,
            rewarded,
            faulted,
        }
        .publish(&env);
        Ok(())
    }

    /// Accrues `amount` to `reporter`'s claimable reward balance,
    /// capped at whatever `RewardPool` currently holds (Section 7.5:
    /// "If the bucket runs short, an accrual is capped at what it
    /// holds; nothing is owed beyond that"). Also records the fault
    /// side effects (suspension/slash) are handled separately by
    /// `record_fault`.
    fn accrue_reward_capped(env: &Env, reporter: &Address, amount: i128) {
        let pool = storage::get_reward_pool(env);
        let granted = if amount > pool { pool } else { amount };
        if granted <= 0 {
            return;
        }
        storage::set_reward_pool(env, pool - granted);
        storage::add_accrued_reward(env, reporter, granted);
    }

    /// Records one fault for `reporter` at `now`, pruning fault times
    /// outside `FAULT_WINDOW_SECS` first, then slashes and suspends if
    /// the pruned, incremented count exceeds `REPORTER_MAX_FAULTS`
    /// (Section 7.5).
    fn record_fault(env: &Env, reporter: &Address, now: u64, treasury: &Address) {
        let Some(mut info) = storage::get_reporter(env, reporter) else {
            return;
        };
        let mut fault_times = Vec::new(env);
        for t in info.fault_times.iter() {
            if now.saturating_sub(t) <= params::FAULT_WINDOW_SECS {
                fault_times.push_back(t);
            }
        }
        fault_times.push_back(now);
        info.fault_times = fault_times;

        if info.fault_times.len() > params::REPORTER_MAX_FAULTS && !info.suspended {
            // `slash_amount` is a percentage (REPORTER_SLASH_BPS <=
            // 10_000) of `info.stake` itself, so it can never exceed
            // `info.stake`: no `min`/overpay risk here the way
            // `slash`'s caller-supplied `amount` has (review fix S5).
            // `checked_sub` still replaces the previous
            // `saturating_sub`, per the review's "remove
            // saturating_sub from every money path" instruction, even
            // though it cannot actually underflow given the above.
            let slash_amount = info.stake * params::REPORTER_SLASH_BPS / 10_000;
            info.stake = info
                .stake
                .checked_sub(slash_amount)
                .expect("slash_amount is bounded by info.stake; cannot underflow");
            info.suspended = true;
            storage::set_reporter(env, reporter, &info);
            // No bonded counterparty for a fault slash (Section 7.5
            // gives the split as 50/50 winner/Treasury, but a fault is
            // not a dispute with a winner): the whole amount goes to
            // the Treasury address, mirroring the "no bonded
            // counterparty... 100% goes to the Treasury" rule Section
            // 7.8 states for the analogous case on bond forfeits.
            // Review fix (found alongside S5): this credit was
            // previously missing entirely (`let _ = to_treasury;`
            // discarded it) -- the slashed stake was deducted but
            // never reached anyone, an S1-adjacent bug of its own
            // (not an overpay, but a silent loss from the tracked
            // liabilities side).
            storage::add_claimable(env, treasury, slash_amount);
            events::Slashed {
                who: reporter.clone(),
                amount: slash_amount,
                requested_amount: slash_amount,
                winner: None,
                to_treasury: slash_amount,
                reason: BytesN::from_array(env, &[0u8; 32]),
                suspended: true,
            }
            .publish(env);
        } else {
            storage::set_reporter(env, reporter, &info);
        }
    }

    // -- bond escrow and slashing (Section 7.8, 12.3) --

    /// technical-doc.md Section 12.3: auth `RiskOracle` for
    /// `SignalDispute` keys, `EventRegistry` for `EventProposal`/
    /// `EventChallenge` keys. `subject` (lead decision, feat/staking):
    /// `Some(keeper)` required for `SignalDispute` (the keeper whose
    /// posting is being disputed, so a later `remove_keeper` can
    /// withhold bond release while this stays open), `None` required
    /// for the event kinds. A mismatch is `InvalidBondSubject`, not
    /// silently ignored.
    pub fn lock_bond(
        env: Env,
        key: BondKey,
        owner: Address,
        amount: i128,
        subject: Option<Address>,
    ) -> Result<(), Error> {
        let config = Self::require_config(&env)?;
        Self::require_bond_caller(&env, &config, &key)?;
        Self::require_valid_subject(&key, &subject)?;
        if amount <= 0 {
            // PR #7 approval fix: without this, a zero (or negative)
            // bond would still increment the subject keeper's
            // open_dispute_count below, with no real collateral ever
            // locked to justify it.
            return Err(Error::InvalidAmount);
        }
        if storage::get_bond(&env, &key).is_some() {
            return Err(Error::BondExists);
        }

        let usdc = token::TokenClient::new(&env, &config.usdc);
        usdc.transfer(
            &owner,
            soroban_sdk::MuxedAddress::from(env.current_contract_address()),
            &amount,
        );
        storage::set_bond(
            &env,
            &key,
            &BondRecord {
                owner: owner.clone(),
                amount,
                subject: subject.clone(),
            },
        );
        if let Some(keeper) = &subject {
            Self::increment_open_disputes(&env, keeper);
        }

        events::BondLocked { owner, key, amount }.publish(&env);
        Ok(())
    }

    /// Credits the full bond back to its owner's claimable balance.
    /// Auth: whichever contract locked the bond (read from the
    /// record's `owner`'s... no: Section 12.3 says "the contract that
    /// locked it", which for every `BondKey` kind this contract
    /// handles is always `oracle` for `SignalDispute` and `registry`
    /// for the event kinds, the same mapping `lock_bond` itself
    /// checks, so `release_bond` and `forfeit_bond` reuse
    /// `require_bond_caller` rather than trusting the stored record to
    /// say who may act on it.
    pub fn release_bond(env: Env, key: BondKey) -> Result<(), Error> {
        let config = Self::require_config(&env)?;
        Self::require_bond_caller(&env, &config, &key)?;
        let record = storage::get_bond(&env, &key).ok_or(Error::UnknownBond)?;
        storage::clear_bond(&env, &key);
        storage::add_claimable(&env, &record.owner, record.amount);
        if let Some(keeper) = &record.subject {
            Self::decrement_open_disputes(&env, keeper);
        }
        events::BondReleased {
            owner: record.owner,
            key,
            amount: record.amount,
        }
        .publish(&env);
        Ok(())
    }

    /// 50% to `winner` (if any), 50% to the treasury address (Section
    /// 7.8). With no bonded counterparty (`winner = None`), 100% goes
    /// to the treasury instead, per the same section.
    pub fn forfeit_bond(env: Env, key: BondKey, winner: Option<Address>) -> Result<(), Error> {
        let config = Self::require_config(&env)?;
        Self::require_bond_caller(&env, &config, &key)?;
        let record = storage::get_bond(&env, &key).ok_or(Error::UnknownBond)?;
        storage::clear_bond(&env, &key);

        let (to_winner, to_treasury) = split_half(record.amount);
        if let Some(winner_addr) = &winner {
            storage::add_claimable(&env, winner_addr, to_winner);
            storage::add_claimable(&env, &config.treasury, to_treasury);
        } else {
            storage::add_claimable(&env, &config.treasury, record.amount);
        }
        if let Some(keeper) = &record.subject {
            Self::decrement_open_disputes(&env, keeper);
        }

        let to_treasury_final = if winner.is_some() {
            to_treasury
        } else {
            record.amount
        };
        events::BondForfeited {
            owner: record.owner,
            key,
            amount: record.amount,
            winner,
            to_treasury: to_treasury_final,
        }
        .publish(&env);
        Ok(())
    }

    /// technical-doc.md Section 7.5, 12.3: auth `RiskOracle` or
    /// `EventRegistry`, or the committee (via `Governor`, not wired in
    /// this build; see the PR's "Spec deviations") for false probe
    /// evidence. This build checks `oracle` or `registry` auth only;
    /// a committee initiated slash for false evidence is not callable
    /// yet, since there is no committee address this contract knows
    /// about independent of `RiskOracle`'s own (and `RiskOracle`'s
    /// `resolve_signal_dispute` is the one call site this build's
    /// `slash` actually serves).
    pub fn slash(
        env: Env,
        who: Address,
        amount: i128,
        winner: Option<Address>,
        reason: BytesN<32>,
    ) -> Result<(), Error> {
        let config = Self::require_config(&env)?;
        Self::require_slash_caller(&env, &config)?;
        if amount <= 0 {
            // A non-positive amount is never a real slash (review fix
            // S5, found while fixing the overpay bug): without this
            // check, `amount.min(remaining)` below would return a
            // negative `actual`, and `bond -= actual` would INCREASE
            // the bond rather than reduce it.
            return Err(Error::StakeTooLow);
        }
        let now = env.ledger().timestamp();

        let suspended;
        // S1 (review fix S5): never deduct or pay out more than `who`
        // actually holds. `actual` is the amount genuinely taken;
        // every downstream credit (`to_winner`/`to_treasury`) is
        // computed from `actual`, never from the caller's requested
        // `amount`, so a request exceeding the remaining balance is
        // capped down rather than overpaid from other participants'
        // funds.
        let actual;
        if let Some(mut keeper) = storage::get_keeper(&env, &who) {
            actual = amount.min(keeper.bond);
            keeper.bond -= actual;
            // Section 7.5, 7.8: `keeper_slash` on a lost signal
            // dispute counts as one fault; suspension follows
            // `KEEPER_MAX_FAULTS` in `FAULT_WINDOW_SECS`, the same
            // pruned rolling window `record_fault` uses for reporters.
            let mut fault_times = Vec::new(&env);
            for t in keeper.fault_times.iter() {
                if now.saturating_sub(t) <= params::FAULT_WINDOW_SECS {
                    fault_times.push_back(t);
                }
            }
            fault_times.push_back(now);
            keeper.fault_times = fault_times;
            if keeper.fault_times.len() > params::KEEPER_MAX_FAULTS {
                keeper.suspended = true;
            }
            suspended = keeper.suspended;
            storage::set_keeper(&env, &who, &keeper);
        } else if let Some(mut reporter) = storage::get_reporter(&env, &who) {
            actual = amount.min(reporter.stake);
            reporter.stake -= actual;
            suspended = reporter.suspended;
            storage::set_reporter(&env, &who, &reporter);
        } else {
            return Err(Error::NotKeeper);
        }

        let (to_winner, to_treasury) = split_half(actual);
        if let Some(winner_addr) = &winner {
            storage::add_claimable(&env, winner_addr, to_winner);
            storage::add_claimable(&env, &config.treasury, to_treasury);
        } else {
            storage::add_claimable(&env, &config.treasury, actual);
        }

        let to_treasury_final = if winner.is_some() {
            to_treasury
        } else {
            actual
        };
        events::Slashed {
            who,
            amount: actual,
            requested_amount: amount,
            winner,
            to_treasury: to_treasury_final,
            reason,
            suspended,
        }
        .publish(&env);
        Ok(())
    }

    /// technical-doc.md Section 12.3: auth `RiskOracle`. Declared in
    /// the interface `RiskOracle` depends on but not currently called
    /// from any `RiskOracle` call site (Section 12.3's own note on
    /// this); implemented here as a flat accrual from the same local
    /// reward pool `fund_rewards`/`settle_probes` share, mirroring the
    /// reporter reward design, since leaving half of an interface this
    /// build must implement exactly unimplemented would be a bigger
    /// inconsistency than a stand-in amount. `keeper_reward` (Section
    /// 23, 0.50 USDC per accepted epoch) is the amount used.
    pub fn reward_keeper(env: Env, keeper: Address) -> Result<(), Error> {
        let config = Self::require_config(&env)?;
        Self::require_oracle_caller(&env, &config)?;
        if storage::get_keeper(&env, &keeper).is_none() {
            return Err(Error::NotKeeper);
        }
        Self::accrue_reward_capped(&env, &keeper, params::KEEPER_REWARD_PER_ACCEPTED_EPOCH);
        Ok(())
    }

    // -- rewards (new, feat/staking) --

    /// Anyone may call this now (the task's own scope decision): adds
    /// `amount` of USDC to the unallocated reward pool `settle_probes`
    /// and `reward_keeper` accrue from, pulled from `from`. A stand in
    /// for `Treasury.accrue_reward` (Section 7.5, ADR-004) until
    /// `Treasury` exists; see the module doc comment.
    pub fn fund_rewards(env: Env, from: Address, amount: i128) -> Result<(), Error> {
        from.require_auth();
        if amount <= 0 {
            return Err(Error::StakeTooLow);
        }
        let config = Self::require_config(&env)?;
        let usdc = token::TokenClient::new(&env, &config.usdc);
        usdc.transfer(
            &from,
            soroban_sdk::MuxedAddress::from(env.current_contract_address()),
            &amount,
        );
        let pool_after = storage::get_reward_pool(&env)
            .checked_add(amount)
            .ok_or(Error::MathOverflow)?;
        storage::set_reward_pool(&env, pool_after);
        events::RewardsFunded {
            from,
            amount,
            pool_after,
        }
        .publish(&env);
        Ok(())
    }

    /// Pays out `reporter`'s accrued reward balance.
    pub fn claim_rewards(env: Env, reporter: Address) -> Result<i128, Error> {
        reporter.require_auth();
        Self::require_config(&env)?;
        let amount = storage::get_accrued_reward(&env, &reporter);
        if amount <= 0 {
            return Err(Error::NothingToClaim);
        }
        storage::clear_accrued_reward(&env, &reporter);
        let config = Self::require_config(&env)?;
        let usdc = token::TokenClient::new(&env, &config.usdc);
        usdc.transfer(
            &env.current_contract_address(),
            soroban_sdk::MuxedAddress::from(reporter.clone()),
            &amount,
        );
        events::StakingRewardClaimed {
            who: reporter,
            amount,
        }
        .publish(&env);
        Ok(amount)
    }

    /// technical-doc.md Section 7.8, 12.3: pays refunds and winnings
    /// from bond settlement. Distinct from `claim_rewards` (reporter
    /// probe rewards): different balance, different funding source.
    pub fn claim(env: Env, who: Address) -> Result<i128, Error> {
        who.require_auth();
        let config = Self::require_config(&env)?;
        let amount = storage::get_claimable(&env, &who);
        if amount <= 0 {
            return Err(Error::NothingToClaim);
        }
        storage::clear_claimable(&env, &who);
        let usdc = token::TokenClient::new(&env, &config.usdc);
        usdc.transfer(
            &env.current_contract_address(),
            soroban_sdk::MuxedAddress::from(who.clone()),
            &amount,
        );
        events::Claimed { who, amount }.publish(&env);
        Ok(amount)
    }

    // -- reads (Section 12.3) --

    pub fn keeper(env: Env, keeper: Address) -> Option<KeeperInfo> {
        storage::get_keeper(&env, &keeper)
    }

    pub fn is_active_keeper(env: Env, keeper: Address) -> bool {
        match storage::get_keeper(&env, &keeper) {
            Some(info) => {
                !info.suspended && info.removed_at.is_none() && info.bond >= params::KEEPER_BOND
            }
            None => false,
        }
    }

    pub fn reporter(env: Env, reporter: Address) -> Option<ReporterInfo> {
        storage::get_reporter(&env, &reporter)
    }

    pub fn bond(env: Env, key: BondKey) -> Option<(Address, i128)> {
        storage::get_bond(&env, &key).map(|record| (record.owner, record.amount))
    }

    pub fn claimable(env: Env, who: Address) -> i128 {
        storage::get_claimable(&env, &who)
    }

    pub fn accrued_reward(env: Env, who: Address) -> i128 {
        storage::get_accrued_reward(&env, &who)
    }

    pub fn reward_pool(env: Env) -> i128 {
        storage::get_reward_pool(&env)
    }

    /// Returns every still present probe for (asset, epoch), decoded
    /// back to the plain `ProbeReport` shape Section 12.3 specifies
    /// (the region snapshot, lead decision feat/staking, is internal
    /// bookkeeping, not part of this read's contract).
    pub fn probes(env: Env, asset: Address, epoch: u64) -> Vec<ProbeReport> {
        let (_, reports) = Self::collect_reports(&env, &asset, epoch);
        let mut out = Vec::new(&env);
        for stored in reports.iter() {
            out.push_back(stored.report.clone());
        }
        out
    }

    // -- internal helpers --

    fn require_bond_caller(_env: &Env, config: &Config, key: &BondKey) -> Result<(), Error> {
        match key {
            BondKey::SignalDispute(_, _) => {
                config.oracle.require_auth();
                Ok(())
            }
            BondKey::EventProposal(_) | BondKey::EventChallenge(_) => {
                config.registry.require_auth();
                Ok(())
            }
        }
    }

    fn require_valid_subject(key: &BondKey, subject: &Option<Address>) -> Result<(), Error> {
        match key {
            BondKey::SignalDispute(_, _) => {
                if subject.is_none() {
                    return Err(Error::InvalidBondSubject);
                }
            }
            BondKey::EventProposal(_) | BondKey::EventChallenge(_) => {
                if subject.is_some() {
                    return Err(Error::InvalidBondSubject);
                }
            }
        }
        Ok(())
    }

    /// technical-doc.md Section 12.3 names the caller set as
    /// `RiskOracle` OR `EventRegistry`. Soroban's `require_auth()`
    /// traps on the first address that did not actually authorize the
    /// call, with no non-panicking variant and no portable "who
    /// invoked this call" read; checking two candidate addresses in
    /// sequence is therefore not possible without the wrong one
    /// trapping first, not failing gracefully into the next check.
    /// This build requires `oracle`'s auth only: `EventRegistry` is
    /// not implemented in this PR, so there is no real call site to
    /// support the other branch against yet. Flagged in the PR's
    /// "Spec deviations" section as a real gap `EventRegistry`'s own
    /// build needs to close, most likely by giving `Staking` a way to
    /// distinguish its caller (for example, two separate functions,
    /// or a kind argument this call already effectively has via
    /// `BondKey`'s own variant, extended to `slash` too).
    fn require_slash_caller(env: &Env, config: &Config) -> Result<(), Error> {
        let _ = env;
        config.oracle.require_auth();
        Ok(())
    }

    fn require_oracle_caller(env: &Env, config: &Config) -> Result<(), Error> {
        let _ = env;
        config.oracle.require_auth();
        Ok(())
    }

    fn increment_open_disputes(env: &Env, keeper: &Address) {
        if let Some(mut info) = storage::get_keeper(env, keeper) {
            info.open_dispute_count += 1;
            storage::set_keeper(env, keeper, &info);
        }
    }

    fn decrement_open_disputes(env: &Env, keeper: &Address) {
        if let Some(mut info) = storage::get_keeper(env, keeper) {
            info.open_dispute_count = info
                .open_dispute_count
                .checked_sub(1)
                .expect("open_dispute_count underflow: a bond settled twice for the same subject");
            storage::set_keeper(env, keeper, &info);
        }
    }

    fn require_config(env: &Env) -> Result<Config, Error> {
        env.storage()
            .instance()
            .get(&CONFIG_KEY)
            .ok_or(Error::NotInitialized)
    }
}

#[cfg(test)]
mod test;
