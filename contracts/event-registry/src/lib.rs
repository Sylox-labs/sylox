#![no_std]

//! EventRegistry: event definitions, Tier 1 proposals, Tier 2 claims and
//! disputes, Tier 3 rulings, final event status. technical-doc.md Section 8.

use soroban_sdk::{contract, contractimpl, Address, Env};

#[contract]
pub struct EventRegistry;

#[contractimpl]
impl EventRegistry {
    pub fn initialize(_env: Env, _governor: Address, _oracle: Address, _usdc: Address) {
        todo!("Section 12.2: initialize")
    }
}

#[cfg(test)]
mod test;
