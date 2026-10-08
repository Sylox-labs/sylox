#![no_std]

//! Adapter wrapping a Soroban AMM's reserves, used by RiskOracle as a
//! peg_ratio cross check. technical-doc.md Section 3.3, 5.3.
//!
//! Interface is provisional: not yet specified by the technical doc,
//! which only requires a "fixed interface, so a dependency can be
//! swapped by governance without changing core contracts" (Section 3.3).

use soroban_sdk::{contract, contractimpl, Address, Env};

#[contract]
pub struct AmmSoroswapAdapter;

#[contractimpl]
impl AmmSoroswapAdapter {
    /// Returns the spot price of `asset` in USDC, SCALE 1e7, and the
    /// pool's liquidity in USDC units, for the AMM tolerance cross check
    /// in Section 5.3 step 3.
    pub fn spot_price(_env: Env, _asset: Address) -> (i128, i128) {
        todo!("provisional: not yet specified by technical-doc.md")
    }
}
