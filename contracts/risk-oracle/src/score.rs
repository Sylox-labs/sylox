//! Risk score: the Section 6 formula, bands, hysteresis and staleness.
//! technical-doc.md Section 6, 6.5.

use soroban_sdk::{contracttype, Address, Env, Map, Symbol, Vec};
use sylox_types::{Band, EndpointStatus, RiskScore, SCALE};

use crate::error::Error;
use crate::storage;

/// Epochs the 24 hour and 7 day aggregates look back, and the slots
/// `median_liquidity` (Section 11.1) uses. Both read the newest 168 of
/// the ring's 240 slots (Section 6.5, 5.8).
const AGGREGATE_SLOTS_24H: u32 = 24;
pub const AGGREGATE_SLOTS_7D: u32 = 168;

#[contracttype]
#[derive(Clone)]
pub struct Formula {
    pub version: u32,
    /// [w_P, w_E, w_R, w_I, w_L, w_S], bps, sums to 10,000.
    pub weights: Vec<u32>,
    /// d_max, r_max, c_max, k_max, s_max_bps, l_target (per asset default;
    /// an asset specific L_target overrides this if `params` holds one
    /// keyed by the asset's own address encoded as a Symbol is not
    /// possible in Soroban, so L_target is instead passed per call from
    /// `AssetConfig` in Phase 2 — see `score_for` below).
    pub params: Map<Symbol, i128>,
}

const D_MAX: Symbol = soroban_sdk::symbol_short!("d_max");
const R_MAX: Symbol = soroban_sdk::symbol_short!("r_max");
const C_MAX: Symbol = soroban_sdk::symbol_short!("c_max");
const K_MAX: Symbol = soroban_sdk::symbol_short!("k_max");
const S_MAX_BPS: Symbol = soroban_sdk::symbol_short!("s_max_bp");

pub fn default_formula(env: &Env) -> Formula {
    let mut weights = Vec::new(env);
    // w_P, w_E, w_R, w_I, w_L, w_S. technical-doc.md Section 6.2.
    for w in [3_500u32, 2_000, 1_500, 1_500, 1_000, 500] {
        weights.push_back(w);
    }
    let mut params = Map::new(env);
    params.set(D_MAX, SCALE / 10); // 0.10
    params.set(R_MAX, SCALE / 10); // 0.10
    params.set(C_MAX, SCALE / 100); // 0.01
    params.set(K_MAX, 20);
    params.set(S_MAX_BPS, 2_000);
    Formula {
        version: 1,
        weights,
        params,
    }
}

pub fn validate_weights(weights: &Vec<u32>) -> Result<(), Error> {
    if weights.len() != 6 {
        return Err(Error::WeightsInvalid);
    }
    let sum: u32 = weights.iter().sum();
    if sum != 10_000 {
        return Err(Error::WeightsInvalid);
    }
    Ok(())
}

/// `clamp(x) = min(max(x, 0), 1)`, fixed point at `SCALE`. technical-doc.md
/// Section 6.1.
fn clamp(x: i128) -> i128 {
    x.clamp(0, SCALE)
}

/// Component P: peg deviation. `100 * clamp(|1 - peg_ratio_p10| / d_max)`.
fn component_p(peg_ratio_p10: i128, d_max: i128) -> i128 {
    let deviation = (SCALE - peg_ratio_p10).abs();
    100 * clamp(deviation * SCALE / d_max) / SCALE
}

/// Component E: endpoint health. Fixed table, not a ratio against SCALE.
fn component_e(endpoint: EndpointStatus) -> i128 {
    match endpoint {
        EndpointStatus::Up => 0,
        EndpointStatus::Unknown => 30,
        EndpointStatus::Degraded => 50,
        EndpointStatus::Down => 100,
    }
}

/// Component R: redemption pressure.
/// `100 * clamp(redemption_net_24h / (supply * r_max))`.
fn component_r(redemption_net_24h: i128, supply: i128, r_max: i128) -> i128 {
    if supply <= 0 {
        return 0;
    }
    let denom = supply.saturating_mul(r_max) / SCALE;
    if denom <= 0 {
        return 0;
    }
    100 * clamp(redemption_net_24h * SCALE / denom) / SCALE
}

/// Component I: issuer actions.
/// `100 * clamp(clawback_amount_7d / (supply * c_max) + auth_revocations_7d / k_max)`.
fn component_i(
    clawback_amount_7d: i128,
    auth_revocations_7d: u32,
    supply: i128,
    c_max: i128,
    k_max: i128,
) -> i128 {
    let clawback_term = if supply > 0 {
        let denom = supply.saturating_mul(c_max) / SCALE;
        if denom > 0 {
            clawback_amount_7d * SCALE / denom
        } else {
            0
        }
    } else {
        0
    };
    let revocation_term = if k_max > 0 {
        (auth_revocations_7d as i128) * SCALE / k_max
    } else {
        0
    };
    100 * clamp(clawback_term + revocation_term) / SCALE
}

/// Component L: liquidity. `100 * clamp(1 - liquidity_2pct / L_target)`.
fn component_l(liquidity_2pct: i128, l_target: i128) -> i128 {
    if l_target <= 0 {
        return 0;
    }
    100 * clamp(SCALE - (liquidity_2pct * SCALE / l_target)) / SCALE
}

/// Component S: supply shock.
/// `100 * clamp(|supply_change_24h_bps| / s_max_bps)`.
fn component_s(supply_change_24h_bps: i128, s_max_bps: i128) -> i128 {
    if s_max_bps <= 0 {
        return 0;
    }
    100 * clamp(supply_change_24h_bps.abs() * SCALE / s_max_bps) / SCALE
}

/// Everything read from the ring to feed the six components, for one
/// asset at the latest Final epoch. Computed by `aggregate_from_ring`,
/// which reads only the slots it needs (`AGGREGATE_SLOTS_7D`, via
/// `storage::get_window`), never the whole buffer.
pub struct Aggregates {
    pub peg_ratio_p10: i128,
    pub liquidity_2pct: i128,
    pub endpoint: EndpointStatus,
    pub supply: i128,
    pub redemption_net_24h: i128,
    pub clawback_amount_7d: i128,
    pub auth_revocations_7d: u32,
    pub supply_change_24h_bps: i128,
}

/// Reads the newest `AGGREGATE_SLOTS_7D` ring slots ending at `latest_epoch`
/// and folds them into the aggregates every score component needs.
/// `latest_epoch` must be a Final epoch (the caller's responsibility; this
/// function only reads, it does not check finality beyond what
/// `storage::get_window` already does by treating a non-matching or empty
/// slot as missing).
pub fn aggregate_from_ring(
    env: &Env,
    asset: &Address,
    latest_epoch: u64,
) -> Result<Aggregates, Error> {
    if latest_epoch + 1 < AGGREGATE_SLOTS_7D as u64 {
        // Not enough history yet for a 7 day baseline; treat as stale
        // rather than scoring on a partial window silently.
        return Err(Error::SanityBoundFailed);
    }
    let start = latest_epoch + 1 - AGGREGATE_SLOTS_7D as u64;
    let window = storage::get_window(env, asset, start, AGGREGATE_SLOTS_7D);

    let latest = window
        .get(AGGREGATE_SLOTS_7D - 1)
        .flatten()
        .ok_or(Error::SanityBoundFailed)?;

    let mut redemption_net_24h: i128 = 0;
    for i in (AGGREGATE_SLOTS_7D - AGGREGATE_SLOTS_24H)..AGGREGATE_SLOTS_7D {
        if let Some(slot) = window.get(i).flatten() {
            redemption_net_24h += slot.redemption_net;
        }
    }

    let mut clawback_amount_7d: i128 = 0;
    let mut auth_revocations_7d: u32 = 0;
    for i in 0..AGGREGATE_SLOTS_7D {
        if let Some(slot) = window.get(i).flatten() {
            clawback_amount_7d += slot.clawback_amount;
            auth_revocations_7d += slot.auth_revocations;
        }
    }

    // supply_change_24h_bps: the latest epoch's posted supply_change_bps
    // is a one-epoch figure (Section 11.3); the 24h component instead
    // compares supply now against supply 24 slots ago, matching S's
    // definition ("supply_change_24h_bps") rather than reusing the
    // one-epoch field under a 24h sounding name.
    let supply_change_24h_bps = window
        .get(AGGREGATE_SLOTS_7D - AGGREGATE_SLOTS_24H)
        .flatten()
        .filter(|slot| slot.supply > 0)
        .map(|slot| ((latest.supply - slot.supply) * 10_000) / slot.supply)
        .unwrap_or(0);

    Ok(Aggregates {
        peg_ratio_p10: latest.peg_ratio,
        liquidity_2pct: latest.liquidity_2pct,
        endpoint: latest.endpoint,
        supply: latest.supply,
        redemption_net_24h,
        clawback_amount_7d,
        auth_revocations_7d,
        supply_change_24h_bps,
    })
}

/// Combines the six components into the Section 6.2 score, `w_P P + w_E E
/// + ... + w_S S`, rounded to the nearest whole point.
pub fn combined_score(
    formula: &Formula,
    aggregates: &Aggregates,
    l_target: i128,
) -> Result<u32, Error> {
    let d_max = formula.params.get(D_MAX).unwrap_or(SCALE / 10);
    let r_max = formula.params.get(R_MAX).unwrap_or(SCALE / 10);
    let c_max = formula.params.get(C_MAX).unwrap_or(SCALE / 100);
    let k_max = formula.params.get(K_MAX).unwrap_or(20);
    let s_max_bps = formula.params.get(S_MAX_BPS).unwrap_or(2_000);

    let p = component_p(aggregates.peg_ratio_p10, d_max);
    let e = component_e(aggregates.endpoint);
    let r = component_r(aggregates.redemption_net_24h, aggregates.supply, r_max);
    let i = component_i(
        aggregates.clawback_amount_7d,
        aggregates.auth_revocations_7d,
        aggregates.supply,
        c_max,
        k_max,
    );
    let l = component_l(aggregates.liquidity_2pct, l_target);
    let s = component_s(aggregates.supply_change_24h_bps, s_max_bps);

    let weighted = formula.weights.get(0).unwrap() as i128 * p
        + formula.weights.get(1).unwrap() as i128 * e
        + formula.weights.get(2).unwrap() as i128 * r
        + formula.weights.get(3).unwrap() as i128 * i
        + formula.weights.get(4).unwrap() as i128 * l
        + formula.weights.get(5).unwrap() as i128 * s;

    // Weighted sum is in bps-of-score units (weights sum to 10,000); divide
    // back down and round to the nearest point.
    let rounded = (weighted + 5_000) / 10_000;
    rounded
        .clamp(0, 100)
        .try_into()
        .map_err(|_| Error::MathOverflow)
}

/// Section 6.3's score-range bands, before any override or hysteresis.
pub fn band_for_score(score: u32) -> Band {
    match score {
        0..=24 => Band::Normal,
        25..=49 => Band::Watch,
        50..=74 => Band::Warning,
        _ => Band::Distress,
    }
}

/// Section 6.4 hysteresis, applied to a freshly computed `(score, raw_band)`
/// against the asset's stored `RiskScore`. An upward move (toward
/// Distress) applies immediately; a downward move only applies once the
/// new, lower band has qualified for `band_down_epochs` consecutive
/// epochs in a row. `down_streak` is the running count of consecutive
/// epochs the raw band has qualified for a lower band than what is
/// currently stored; the caller persists the returned streak alongside
/// the score.
///
/// Does not implement the Section 6.3 "forced to Distress if an event is
/// Proposed, Challenged or Escalated" override: `RiskOracle` has no stored
/// flag and no API path to learn that from `EventRegistry` (see the PR's
/// "Spec deviations" section). The "forced to at least Warning if P = 100
/// or E = 100" override and the sticky `Event` band (via
/// `set_event_band`/`clear_event_band`) are both implemented.
pub fn apply_hysteresis(
    current: &RiskScore,
    raw_band: Band,
    down_streak: u32,
    band_down_epochs: u32,
) -> (Band, u32) {
    if current.band == Band::Event {
        // Event is sticky until clear_event_band; a freshly computed band
        // never overrides it (handled by the caller not calling this at
        // all while Event is set, but kept here too as a defensive
        // invariant rather than relying solely on call order).
        return (Band::Event, 0);
    }
    if raw_band >= current.band {
        (raw_band, 0)
    } else {
        let streak = down_streak + 1;
        if streak >= band_down_epochs {
            (raw_band, 0)
        } else {
            (current.band, streak)
        }
    }
}
