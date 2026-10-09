//! Minimal client interfaces for the contracts RiskOracle calls into, but
//! does not implement. technical-doc.md Section 3.3 (adapters), 12.3
//! (Staking). Each trait lists only the functions RiskOracle actually
//! calls, not that contract's full API; mock contracts implementing these
//! traits live in `test.rs` and `budget_test.rs`, never the production
//! build.

use soroban_sdk::{contractclient, Address, BytesN, Env};
use sylox_types::{BondKey, EndpointStatus, FxRateSource};

// Each trait below exists only to drive #[contractclient]'s codegen of
// the matching *Client struct; nothing calls the trait itself, which is
// why `cargo check` reports it as dead code without this allow.

/// The slice of `Staking`'s API (Section 12.3) that `RiskOracle` calls.
#[contractclient(name = "StakingClient")]
#[allow(dead_code)]
pub trait Staking {
    fn is_active_keeper(env: Env, keeper: Address) -> bool;
    fn aggregate(env: Env, asset: Address, epoch: u64) -> EndpointStatus;
    fn settle_probes(env: Env, asset: Address, epoch: u64);
    fn lock_bond(env: Env, key: BondKey, owner: Address, amount: i128, subject: Option<Address>);
    fn release_bond(env: Env, key: BondKey);
    fn forfeit_bond(env: Env, key: BondKey, winner: Option<Address>);
    fn slash(env: Env, who: Address, amount: i128, winner: Option<Address>, reason: BytesN<32>);
    fn reward_keeper(env: Env, keeper: Address, epochs: u32) -> i128;
}

/// technical-doc.md Section 3.3. One per Soroban AMM, listed per asset in
/// `AssetConfig.amm_adapters`.
#[contractclient(name = "PriceAdapterClient")]
#[allow(dead_code)]
pub trait PriceAdapter {
    /// (price: USDC per unit of `asset`, SCALE 1e7; liquidity: USDC units
    /// within 2% of that price; timestamp: ledger time the reserves were
    /// read at).
    fn spot_price(env: Env, asset: Address) -> (i128, i128, u64);
}

/// technical-doc.md Section 3.3. Set per asset in `AssetConfig.fx_adapter`
/// when `AssetConfig.reference` is `Fiat`.
#[contractclient(name = "FxAdapterClient")]
#[allow(dead_code)]
pub trait FxAdapter {
    /// (rate: USD per unit of `code`, SCALE 1e7, on the requested basis;
    /// timestamp: time of the source observation).
    fn rate(env: Env, code: soroban_sdk::Symbol, rate_source: FxRateSource) -> (i128, u64);
}

/// The slice of `Governor`'s API (Section 12.6) that `RiskOracle` calls:
/// resolving the current committee address for `resolve_signal_dispute`'s
/// auth check (Section 12.1 lists its auth as "committee"; the committee
/// address itself is a `Governor` read, Section 12.6, not a separate
/// address `RiskOracle` is initialized with).
#[contractclient(name = "GovernorClient")]
#[allow(dead_code)]
pub trait Governor {
    fn committee(env: Env) -> Address;
}
