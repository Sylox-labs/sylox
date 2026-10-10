//! Soroban transaction resource limits, for budget tests across every
//! contract crate to assert against the SAME numbers rather than each
//! hardcoding its own copy from memory.
//!
//! Queried live via `stellar network settings --network <testnet|mainnet>`
//! on 2026-10-09 (testnet) and against a public mainnet RPC endpoint the
//! same day (the `stellar` CLI's own `--network mainnet` alias has no
//! default RPC URL configured in this environment). Testnet and mainnet
//! reported identical values for every limit below; where a future
//! query finds them diverge, use the lower of the two here, per the PR
//! review's own instruction.
//!
//! Re-query and update this file (noting the new date) whenever a
//! network upgrade changes these values; do not let a budget test drift
//! from the live network by hardcoding a remembered number elsewhere.

/// `contract_compute_v0.tx_max_instructions`.
pub const TX_MAX_INSTRUCTIONS: u64 = 400_000_000;

/// `contract_ledger_cost_v0.tx_max_write_bytes`.
pub const TX_MAX_WRITE_BYTES: u64 = 132_096;

/// `contract_ledger_cost_v0.tx_max_disk_read_entries`.
pub const TX_MAX_READ_LEDGER_ENTRIES: u32 = 200;

/// `contract_ledger_cost_v0.tx_max_write_ledger_entries`.
pub const TX_MAX_WRITE_LEDGER_ENTRIES: u32 = 200;

/// `contract_max_size_bytes`: the per-contract Wasm size ceiling, not a
/// per-transaction resource, but queried from the same source and kept
/// alongside the others so every size check in this workspace (budget
/// tests and CI's own `CONTRACT_MAX_SIZE_BYTES`) traces to one place.
pub const CONTRACT_MAX_SIZE_BYTES: u64 = 131_072;

/// `max_entry_size` (`ConfigSettingId::ContractDataEntrySizeBytes`): the
/// largest a single `LedgerEntry` may be. technical-doc.md Section 5.8,
/// 5.9. Previously a bare literal in `risk-oracle/src/budget_test.rs`
/// and `sylox_types::time`'s own build-time ring-size assertions; moved
/// here so both trace to the same queried source as every other limit
/// in this file.
pub const CONTRACT_DATA_ENTRY_SIZE_BYTES: u64 = 65_536;
