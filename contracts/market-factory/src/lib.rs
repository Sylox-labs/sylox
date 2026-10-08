#![no_std]

//! MarketFactory: opens series, tracks the series index, enforces global
//! caps, deploys Series contracts. technical-doc.md Section 9, 11.1.

use soroban_sdk::{contract, contractimpl, Address, BytesN, Env};

#[contract]
pub struct MarketFactory;

#[contractimpl]
impl MarketFactory {
    pub fn initialize(
        _env: Env,
        _governor: Address,
        _oracle: Address,
        _registry: Address,
        _usdc: Address,
        _series_wasm: BytesN<32>,
    ) {
        todo!("Section 12.4: initialize")
    }
}

#[cfg(test)]
mod test;
