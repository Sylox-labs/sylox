#![no_std]

//! Staking: keeper bonds, reporter stakes and probes, signal dispute bonds,
//! event proposal and challenge bonds; executes slashing on instruction from
//! RiskOracle and EventRegistry. technical-doc.md Section 7, 12.3, ADR-004.

use soroban_sdk::{contract, contractimpl, Address, Env};

#[contract]
pub struct Staking;

#[contractimpl]
impl Staking {
    pub fn initialize(
        _env: Env,
        _governor: Address,
        _oracle: Address,
        _registry: Address,
        _treasury: Address,
        _usdc: Address,
    ) {
        todo!("Section 12.3: initialize")
    }
}

#[cfg(test)]
mod test;
