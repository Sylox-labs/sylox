#![no_std]

//! RiskOracle: stores per asset signals per epoch, computes the score,
//! exposes bands and staleness. technical-doc.md Section 5.

use soroban_sdk::{contract, contractimpl, Address, Env};

#[contract]
pub struct RiskOracle;

#[contractimpl]
impl RiskOracle {
    pub fn initialize(_env: Env, _governor: Address, _registry: Address, _staking: Address) {
        todo!("Section 12.1: initialize")
    }
}

#[cfg(test)]
mod test;
