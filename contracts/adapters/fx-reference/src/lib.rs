#![no_std]

//! Adapter wrapping an existing Stellar price oracle (Reflector, DIA, Band)
//! for fiat reference rates. technical-doc.md Section 3.3, 5.3.
//!
//! Interface is provisional: which feeds cover NGN and other local
//! currencies is an open question (PRD Appendix B, technical-doc.md
//! Section 24.2).

use soroban_sdk::{contract, contractimpl, Env, Symbol};

#[contract]
pub struct FxReferenceAdapter;

#[contractimpl]
impl FxReferenceAdapter {
    /// Returns the reference rate for `currency` in USD, SCALE 1e7.
    pub fn rate(_env: Env, _currency: Symbol) -> i128 {
        todo!("provisional: not yet specified by technical-doc.md")
    }
}
