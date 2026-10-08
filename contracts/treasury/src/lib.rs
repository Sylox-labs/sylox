#![no_std]

//! Treasury: protocol fees, slashed funds, and the keeper and reporter
//! reward pools. technical-doc.md Section 12.7, ADR-004.

use soroban_sdk::{contract, contractimpl, Address, Env};

#[contract]
pub struct Treasury;

#[contractimpl]
impl Treasury {
    pub fn initialize(_env: Env, _governor: Address, _staking: Address, _usdc: Address) {
        todo!("Section 12.7: initialize")
    }
}

#[cfg(test)]
mod test;
