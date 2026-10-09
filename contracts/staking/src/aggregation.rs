//! Pure aggregation logic for Section 7.4. Kept separate from
//! `lib.rs`'s `aggregate` and `settle_epoch` contract methods so the
//! one function both call shares exactly one implementation (S4: no
//! function may ever write from this module; it takes already read
//! data and returns a computed status, nothing else).

use soroban_sdk::{Env, Symbol, Vec};
use sylox_types::EndpointStatus;

use crate::params;
use crate::storage::StoredProbe;

/// Section 7.4: at least `MIN_REPORTERS` reports from at least
/// `MIN_DISTINCT_REGIONS` distinct regions are needed for a status
/// other than `Unknown`. Status = the status reported by a strict
/// majority (more than half of the reports received); no strict
/// majority, `Degraded`.
///
/// `reports` is whatever the caller already read (every still present
/// `StoredProbe` for one asset epoch, from the submitter index, lead
/// decision feat/staking): this function does not read storage itself
/// and never writes, satisfying S4 by construction, not by convention.
pub fn compute(env: &Env, reports: &Vec<StoredProbe>) -> EndpointStatus {
    if reports.len() < params::MIN_REPORTERS {
        return EndpointStatus::Unknown;
    }

    let mut regions: Vec<Symbol> = Vec::new(env);
    for report in reports.iter() {
        if !regions.contains(&report.region_at_submission) {
            regions.push_back(report.region_at_submission.clone());
        }
    }
    if regions.len() < params::MIN_DISTINCT_REGIONS {
        return EndpointStatus::Unknown;
    }

    let mut up = 0u32;
    let mut degraded = 0u32;
    let mut down = 0u32;
    let mut unknown = 0u32;
    for report in reports.iter() {
        match report.report.status {
            EndpointStatus::Up => up += 1,
            EndpointStatus::Degraded => degraded += 1,
            EndpointStatus::Down => down += 1,
            EndpointStatus::Unknown => unknown += 1,
        }
    }

    let total = reports.len();
    // "Strict majority" = more than half of the reports received.
    let majority_threshold = total / 2 + 1;
    if up >= majority_threshold {
        EndpointStatus::Up
    } else if degraded >= majority_threshold {
        EndpointStatus::Degraded
    } else if down >= majority_threshold {
        EndpointStatus::Down
    } else if unknown >= majority_threshold {
        // A strict majority of reporters explicitly reporting Unknown
        // is still a strict majority on one status, per Section 7.4's
        // own wording ("status = the status reported by a strict
        // majority"); it is not the same as the `< MIN_REPORTERS`/
        // `< MIN_DISTINCT_REGIONS` early return above, which reports
        // Unknown for lack of data, not because reporters said so.
        EndpointStatus::Unknown
    } else {
        EndpointStatus::Degraded
    }
}

/// Section 7.5: a report disagrees with the majority in an epoch where
/// the majority had at least `FAULT_MAJORITY_THRESHOLD` reporters.
/// Pure, same reasoning as `compute` above.
pub fn majority_size(reports: &Vec<StoredProbe>, aggregate: EndpointStatus) -> u32 {
    let mut count = 0u32;
    for report in reports.iter() {
        if report.report.status == aggregate {
            count += 1;
        }
    }
    count
}
