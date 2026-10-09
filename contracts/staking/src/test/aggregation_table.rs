//! Table tests for `aggregate`/`aggregation::compute`, Section 7.4:
//!
//! - Fewer than `min_reporters` (3) reports: Unknown.
//! - Fewer than 2 distinct regions: Unknown.
//! - A strict majority (more than half) of one status: that status.
//! - No strict majority: Degraded.
//!
//! Every combination below is driven through the real contract
//! (`submit_probe` + `aggregate`), never `aggregation::compute`
//! directly, so these tests also exercise the region snapshot and
//! submitter index `aggregate` actually reads in production.

use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{Address, Env};
use sylox_types::EndpointStatus;

use super::{add_and_fund_reporter, epoch_close, probe, region, setup};
use crate::params;

fn submit(
    env: &Env,
    fx: &super::Fixture,
    asset: &Address,
    reporters: &[(Address, EndpointStatus)],
) {
    for (r, status) in reporters {
        fx.client.submit_probe(r, &probe(env, asset, 0, *status));
    }
}

#[test]
fn fewer_than_min_reporters_reads_unknown() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    env.ledger().set_timestamp(epoch_close(0));
    let r1 = add_and_fund_reporter(&env, &fx, &region(&env, "eu"), params::REPORTER_STAKE);
    let r2 = add_and_fund_reporter(&env, &fx, &region(&env, "us"), params::REPORTER_STAKE);
    submit(
        &env,
        &fx,
        &asset,
        &[(r1, EndpointStatus::Up), (r2, EndpointStatus::Up)],
    );
    assert_eq!(fx.client.aggregate(&asset, &0), EndpointStatus::Unknown);
}

#[test]
fn exactly_min_reporters_but_only_one_distinct_region_reads_unknown() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    env.ledger().set_timestamp(epoch_close(0));
    let eu = region(&env, "eu");
    let r1 = add_and_fund_reporter(&env, &fx, &eu, params::REPORTER_STAKE);
    let r2 = add_and_fund_reporter(&env, &fx, &eu, params::REPORTER_STAKE);
    let r3 = add_and_fund_reporter(&env, &fx, &eu, params::REPORTER_STAKE);
    submit(
        &env,
        &fx,
        &asset,
        &[
            (r1, EndpointStatus::Up),
            (r2, EndpointStatus::Up),
            (r3, EndpointStatus::Up),
        ],
    );
    assert_eq!(fx.client.aggregate(&asset, &0), EndpointStatus::Unknown);
}

/// "One operator registered once trying to cover two regions" (the
/// task's own named edge case): a single reporter address can only
/// ever contribute ONE region (its own, fixed at `add_reporter`), so
/// no number of probes from the SAME address can ever satisfy the 2
/// distinct region requirement; it takes a second, independently
/// registered reporter.
#[test]
fn one_reporter_address_cannot_cover_two_regions_by_submitting_twice() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    env.ledger().set_timestamp(epoch_close(0));
    let eu = region(&env, "eu");
    let r1 = add_and_fund_reporter(&env, &fx, &eu, params::REPORTER_STAKE);
    let r2 = add_and_fund_reporter(&env, &fx, &eu, params::REPORTER_STAKE);
    let r3 = add_and_fund_reporter(&env, &fx, &eu, params::REPORTER_STAKE);
    // All three are registered under "eu": one reporter cannot also
    // submit again as if it were "us" (submit_probe is one report
    // per reporter per asset per epoch, Section 7.3; a duplicate
    // call for the same (reporter, asset, epoch) is rejected, and
    // even if it were allowed, the region used would still be this
    // reporter's own fixed "eu", never a second region of its choice).
    submit(
        &env,
        &fx,
        &asset,
        &[
            (r1.clone(), EndpointStatus::Up),
            (r2, EndpointStatus::Up),
            (r3, EndpointStatus::Up),
        ],
    );
    let result = fx
        .client
        .try_submit_probe(&r1, &probe(&env, &asset, 0, EndpointStatus::Down));
    assert_eq!(result, Err(Ok(crate::Error::DuplicateProbe)));
    assert_eq!(fx.client.aggregate(&asset, &0), EndpointStatus::Unknown);
}

#[test]
fn strict_majority_up_reads_up() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    env.ledger().set_timestamp(epoch_close(0));
    let r1 = add_and_fund_reporter(&env, &fx, &region(&env, "eu"), params::REPORTER_STAKE);
    let r2 = add_and_fund_reporter(&env, &fx, &region(&env, "us"), params::REPORTER_STAKE);
    let r3 = add_and_fund_reporter(&env, &fx, &region(&env, "af"), params::REPORTER_STAKE);
    submit(
        &env,
        &fx,
        &asset,
        &[
            (r1, EndpointStatus::Up),
            (r2, EndpointStatus::Up),
            (r3, EndpointStatus::Down),
        ],
    );
    assert_eq!(fx.client.aggregate(&asset, &0), EndpointStatus::Up);
}

#[test]
fn strict_majority_degraded_reads_degraded() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    env.ledger().set_timestamp(epoch_close(0));
    let r1 = add_and_fund_reporter(&env, &fx, &region(&env, "eu"), params::REPORTER_STAKE);
    let r2 = add_and_fund_reporter(&env, &fx, &region(&env, "us"), params::REPORTER_STAKE);
    let r3 = add_and_fund_reporter(&env, &fx, &region(&env, "af"), params::REPORTER_STAKE);
    submit(
        &env,
        &fx,
        &asset,
        &[
            (r1, EndpointStatus::Degraded),
            (r2, EndpointStatus::Degraded),
            (r3, EndpointStatus::Up),
        ],
    );
    assert_eq!(fx.client.aggregate(&asset, &0), EndpointStatus::Degraded);
}

#[test]
fn strict_majority_down_reads_down() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    env.ledger().set_timestamp(epoch_close(0));
    let r1 = add_and_fund_reporter(&env, &fx, &region(&env, "eu"), params::REPORTER_STAKE);
    let r2 = add_and_fund_reporter(&env, &fx, &region(&env, "us"), params::REPORTER_STAKE);
    let r3 = add_and_fund_reporter(&env, &fx, &region(&env, "af"), params::REPORTER_STAKE);
    submit(
        &env,
        &fx,
        &asset,
        &[
            (r1, EndpointStatus::Down),
            (r2, EndpointStatus::Down),
            (r3, EndpointStatus::Up),
        ],
    );
    assert_eq!(fx.client.aggregate(&asset, &0), EndpointStatus::Down);
}

#[test]
fn strict_majority_unknown_reads_unknown_distinctly_from_the_too_few_reporters_case() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    env.ledger().set_timestamp(epoch_close(0));
    let r1 = add_and_fund_reporter(&env, &fx, &region(&env, "eu"), params::REPORTER_STAKE);
    let r2 = add_and_fund_reporter(&env, &fx, &region(&env, "us"), params::REPORTER_STAKE);
    let r3 = add_and_fund_reporter(&env, &fx, &region(&env, "af"), params::REPORTER_STAKE);
    submit(
        &env,
        &fx,
        &asset,
        &[
            (r1, EndpointStatus::Unknown),
            (r2, EndpointStatus::Unknown),
            (r3, EndpointStatus::Up),
        ],
    );
    assert_eq!(fx.client.aggregate(&asset, &0), EndpointStatus::Unknown);
}

#[test]
fn no_strict_majority_with_four_reporters_reads_degraded() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    env.ledger().set_timestamp(epoch_close(0));
    let r1 = add_and_fund_reporter(&env, &fx, &region(&env, "eu"), params::REPORTER_STAKE);
    let r2 = add_and_fund_reporter(&env, &fx, &region(&env, "us"), params::REPORTER_STAKE);
    let r3 = add_and_fund_reporter(&env, &fx, &region(&env, "af"), params::REPORTER_STAKE);
    let r4 = add_and_fund_reporter(&env, &fx, &region(&env, "ap"), params::REPORTER_STAKE);
    // 2 Up, 2 Down: exactly half each, neither side exceeds total/2.
    submit(
        &env,
        &fx,
        &asset,
        &[
            (r1, EndpointStatus::Up),
            (r2, EndpointStatus::Up),
            (r3, EndpointStatus::Down),
            (r4, EndpointStatus::Down),
        ],
    );
    assert_eq!(fx.client.aggregate(&asset, &0), EndpointStatus::Degraded);
}

#[test]
fn no_strict_majority_three_way_split_reads_degraded() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    env.ledger().set_timestamp(epoch_close(0));
    let r1 = add_and_fund_reporter(&env, &fx, &region(&env, "eu"), params::REPORTER_STAKE);
    let r2 = add_and_fund_reporter(&env, &fx, &region(&env, "us"), params::REPORTER_STAKE);
    let r3 = add_and_fund_reporter(&env, &fx, &region(&env, "af"), params::REPORTER_STAKE);
    submit(
        &env,
        &fx,
        &asset,
        &[
            (r1, EndpointStatus::Up),
            (r2, EndpointStatus::Degraded),
            (r3, EndpointStatus::Down),
        ],
    );
    assert_eq!(fx.client.aggregate(&asset, &0), EndpointStatus::Degraded);
}

#[test]
fn exactly_half_up_half_down_with_an_even_count_is_not_a_strict_majority() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    env.ledger().set_timestamp(epoch_close(0));
    let r1 = add_and_fund_reporter(&env, &fx, &region(&env, "eu"), params::REPORTER_STAKE);
    let r2 = add_and_fund_reporter(&env, &fx, &region(&env, "us"), params::REPORTER_STAKE);
    let r3 = add_and_fund_reporter(&env, &fx, &region(&env, "af"), params::REPORTER_STAKE);
    let r4 = add_and_fund_reporter(&env, &fx, &region(&env, "ap"), params::REPORTER_STAKE);
    let r5 = add_and_fund_reporter(&env, &fx, &region(&env, "sa"), params::REPORTER_STAKE);
    let r6 = add_and_fund_reporter(&env, &fx, &region(&env, "na"), params::REPORTER_STAKE);
    // 6 reporters: 3 Up is exactly half (3/6), not "more than half"
    // (strict majority requires total/2 + 1 = 4).
    submit(
        &env,
        &fx,
        &asset,
        &[
            (r1, EndpointStatus::Up),
            (r2, EndpointStatus::Up),
            (r3, EndpointStatus::Up),
            (r4, EndpointStatus::Down),
            (r5, EndpointStatus::Down),
            (r6, EndpointStatus::Down),
        ],
    );
    assert_eq!(fx.client.aggregate(&asset, &0), EndpointStatus::Degraded);
}

#[test]
fn strict_majority_with_an_even_reporter_count_still_resolves() {
    let env = Env::default();
    let fx = setup(&env);
    let asset = Address::generate(&env);
    env.ledger().set_timestamp(epoch_close(0));
    let r1 = add_and_fund_reporter(&env, &fx, &region(&env, "eu"), params::REPORTER_STAKE);
    let r2 = add_and_fund_reporter(&env, &fx, &region(&env, "us"), params::REPORTER_STAKE);
    let r3 = add_and_fund_reporter(&env, &fx, &region(&env, "af"), params::REPORTER_STAKE);
    let r4 = add_and_fund_reporter(&env, &fx, &region(&env, "ap"), params::REPORTER_STAKE);
    // 4 reporters: 3 Up is more than half (3 > 2), a strict majority.
    submit(
        &env,
        &fx,
        &asset,
        &[
            (r1, EndpointStatus::Up),
            (r2, EndpointStatus::Up),
            (r3, EndpointStatus::Up),
            (r4, EndpointStatus::Down),
        ],
    );
    assert_eq!(fx.client.aggregate(&asset, &0), EndpointStatus::Up);
}
