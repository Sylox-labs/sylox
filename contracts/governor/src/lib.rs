#![no_std]

//! Governor: multisig owned parameter store, timelock queue, upgrade
//! execution, pause switches. technical-doc.md Section 17.

use soroban_sdk::{contract, contractimpl, Address, Env, Vec};

#[contract]
pub struct Governor;

#[contractimpl]
impl Governor {
    pub fn initialize(
        _env: Env,
        _signers: Vec<Address>,
        _threshold: u32,
        _timelock_secs: u64,
        _committee: Address,
    ) {
        todo!("Section 12.6: initialize")
    }
}

#[cfg(test)]
mod test;
