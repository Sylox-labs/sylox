#![no_std]

//! ReporterStaking: reporter registration, stake, slashing, reward accrual.
//! technical-doc.md Section 7.

use soroban_sdk::{contract, contractimpl, Address, Env, Symbol};

#[contract]
pub struct ReporterStaking;

#[contractimpl]
impl ReporterStaking {
    pub fn add_reporter(_env: Env, _reporter: Address, _region: Symbol) {
        todo!("Section 12.3: add_reporter")
    }
}

#[cfg(test)]
mod test;
