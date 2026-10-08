#![no_std]

//! Series: collateral pool, quotes, cover tokens, share tokens, premiums,
//! claims, withdrawals for one protection market. technical-doc.md Section 9.
//!
//! One instance is deployed per series by MarketFactory from a single
//! uploaded Wasm hash (Section 3.2). Not upgradeable (Section 17.3).

use soroban_sdk::{contract, contractimpl, Address, Env};

#[contract]
pub struct Series;

#[contractimpl]
impl Series {
    pub fn deposit(_env: Env, _seller: Address, _amount: i128) {
        todo!("Section 12.5: deposit")
    }
}

#[cfg(test)]
mod test;
