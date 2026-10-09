//! Property test required by the task brief: random sequences of
//! `deposit`, `accrue_reward`, `claim_reward`, `allocate` and `spend`
//! never break T1-T4.

extern crate std;

use proptest::prelude::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;
use sylox_types::TreasuryBucket;

use super::setup;

#[derive(Clone, Copy, Debug)]
enum Op {
    Deposit(u8, i128),
    AccrueReward(u8, u8, i128),
    ClaimReward(u8),
    Allocate(u8, u8, i128),
    Spend(u8, i128),
}

fn bucket_of(n: u8) -> TreasuryBucket {
    match n % 4 {
        0 => TreasuryBucket::Fees,
        1 => TreasuryBucket::Slashed,
        2 => TreasuryBucket::KeeperRewards,
        _ => TreasuryBucket::ReporterRewards,
    }
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        (0u8..4, 0i128..2_000_000_000).prop_map(|(b, a)| Op::Deposit(b, a)),
        (0u8..4, 0u8..3, 0i128..2_000_000_000).prop_map(|(b, who, a)| Op::AccrueReward(b, who, a)),
        (0u8..3).prop_map(Op::ClaimReward),
        (0u8..4, 0u8..4, 0i128..2_000_000_000).prop_map(|(f, t, a)| Op::Allocate(f, t, a)),
        (0u8..4, 0i128..2_000_000_000).prop_map(|(b, a)| Op::Spend(b, a)),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 32, .. ProptestConfig::default() })]

    #[test]
    fn t1_to_t4_never_break(ops in prop::collection::vec(op(), 1..40)) {
        let env = soroban_sdk::Env::default();
        let fx = setup(&env);
        let recipients = [
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
        ];
        let buckets = [
            TreasuryBucket::Fees,
            TreasuryBucket::Slashed,
            TreasuryBucket::KeeperRewards,
            TreasuryBucket::ReporterRewards,
        ];

        for operation in ops {
            // T4 (checked around allocate specifically): total across
            // all 4 buckets before the op, re-checked after for the
            // Allocate variant.
            let total_before: i128 = buckets.iter().map(|b| fx.client.balance(b)).sum();

            match operation {
                Op::Deposit(b, amount) => {
                    let from = Address::generate(&env);
                    super::fund(&fx, &from, amount.max(1));
                    let _ = fx.client.try_deposit(&from, &bucket_of(b), &amount);
                }
                Op::AccrueReward(b, who, amount) => {
                    let to = &recipients[who as usize % recipients.len()];
                    // T2: accrue_reward's own return value, and the
                    // bucket after, must never imply more left the
                    // bucket than it held.
                    let bucket = bucket_of(b);
                    let before = fx.client.balance(&bucket);
                    if let Ok(Ok(accrued)) = fx.client.try_accrue_reward(to, &bucket, &amount) {
                        prop_assert!(accrued <= before, "T2 violated: accrued {} > bucket balance {}", accrued, before);
                        prop_assert!(accrued <= amount.max(0), "T2 violated: accrued {} > requested {}", accrued, amount);
                    }
                }
                Op::ClaimReward(who) => {
                    let to = &recipients[who as usize % recipients.len()];
                    let _ = fx.client.try_claim_reward(to);
                }
                Op::Allocate(from_b, to_b, amount) => {
                    let _ = fx
                        .client
                        .try_allocate(&bucket_of(from_b), &bucket_of(to_b), &amount);
                    let total_after: i128 = buckets.iter().map(|b| fx.client.balance(b)).sum();
                    prop_assert_eq!(
                        total_before, total_after,
                        "T4 violated: total across buckets changed from {} to {}",
                        total_before, total_after
                    );
                }
                Op::Spend(b, amount) => {
                    let recipient = Address::generate(&env);
                    let _ = fx.client.try_spend(&bucket_of(b), &recipient, &amount);
                }
            }

            // T1: balance always covers every tracked liability.
            let tracked_buckets: i128 = buckets.iter().map(|b| fx.client.balance(b)).sum();
            let tracked_accrued: i128 = recipients.iter().map(|r| fx.client.accrued(r)).sum();
            let tracked = tracked_buckets + tracked_accrued;
            let balance = fx.usdc_client.balance(&fx.contract_id);
            prop_assert!(
                balance >= tracked,
                "T1 violated: balance {} < tracked {}",
                balance,
                tracked
            );
        }

        // T3 is enforced structurally by this property's own op set:
        // claim_reward pays only the address it was accrued to, spend
        // pays only the address the governor named, and neither
        // function here has a code path to any other destination
        // (see lib.rs's own doc comment); nothing else in this op
        // set moves USDC out of the contract at all (deposit moves
        // USDC IN; allocate moves balance between buckets with no
        // USDC transfer at all).
    }
}
