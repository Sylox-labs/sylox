//! Small numeric helpers shared by `score.rs` and `lib.rs`'s
//! `median_liquidity`. Not test-only: `median_liquidity` is a production
//! read (Section 11.1, 12.1).

use soroban_sdk::Vec;

/// Insertion sort over a Soroban `Vec<i128>`. `values` holds at most 168
/// elements in every caller (the 7 day aggregate window, Section 6.5,
/// 11.1), so an O(n^2) sort is cheap enough; a comparison sort over a
/// fixed, small input is simpler to audit than a more complex algorithm
/// for a size where the difference does not matter.
pub fn sorted(values: &Vec<i128>) -> Vec<i128> {
    let mut out = values.clone();
    let len = out.len();
    for i in 1..len {
        let key = out.get(i).unwrap();
        let mut j = i;
        while j > 0 && out.get(j - 1).unwrap() > key {
            let prev = out.get(j - 1).unwrap();
            out.set(j, prev);
            j -= 1;
        }
        out.set(j, key);
    }
    out
}

/// Median of `values`. Even-length inputs take the lower of the two
/// middle elements (matching `len / 2` integer division), not an average:
/// an average could introduce a value that never actually occurred in any
/// slot, which Section 11.1's liquidity floor and cover cap should not be
/// based on.
pub fn median(values: &Vec<i128>) -> i128 {
    let s = sorted(values);
    s.get(s.len() / 2).unwrap()
}
