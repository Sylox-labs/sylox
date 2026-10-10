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

/// `contract_compute_v0.tx_memory_limit`: the total host memory one
/// transaction's invocation may use. Section 5.9 S5's own
/// `cover_gate` unbuilt-hour cap is sized against this: unlike every
/// other limit here, a single transaction's memory cost does not
/// grow smoothly with its own workload (confirmed empirically:
/// `cover_gate` stayed under 7.3MB at 30 unbuilt hours scanned one
/// `sub_peg_ratios` call at a time, then exceeded this entire 40MB
/// limit at 31), so this number is the one every such cap must leave
/// real margin under, not graze.
pub const TX_MEMORY_LIMIT_BYTES: u64 = 41_943_040;

/// `contract_ledger_cost_ext_v0.tx_max_footprint_entries`: the most
/// DISTINCT ledger keys one transaction's footprint (every key read
/// OR written, read once each even if touched more than once) may
/// span. Queried live via `stellar network settings --network
/// testnet` on 2026-10-10. Not tracked here until Section 5.9 S5's own
/// `cover_gate` fix surfaced it, in two stages: first, a per-sub-epoch
/// `SubDispute` lookup inside a loop over many hours touched a
/// separate key per `(hour, sub)` pair, 864 of 945 total at 72
/// unbuilt hours, almost 2.4x this limit; fixed by reading dispute
/// state directly off the already-fetched `Sub(asset)`/`HeldHour`
/// slot instead. Second, even after that fix, an unconditional
/// per-hour `HeldHour` probe (a miss still costs one footprint entry)
/// still scaled with hour count; fixed by removing `HeldHour` from
/// the gate path entirely (it is a write-path, build/dispute-only
/// concern now), leaving `cover_gate`'s own footprint a flat 9
/// entries regardless of how many hours are unbuilt or disputed
/// (`MAX_UNBUILT_HOURS_SCANNED_BY_COVER_GATE`'s own doc comment,
/// `sylox_types::time`).
pub const TX_MAX_FOOTPRINT_ENTRIES: u32 = 400;
