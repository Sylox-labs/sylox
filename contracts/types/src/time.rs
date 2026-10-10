//! Time-derived constants shared across contracts, so a number baked
//! into the hourly ring, the Depeg window or the cure-window bitmap
//! is never silently duplicated or allowed to drift between crates.
//! technical-doc.md Section 5.9 S7. Mirrors `network_limits`'s own
//! style: one constant per line, a doc comment naming its spec
//! source, no logic.
//!
//! Before this module existed, `RING_SLOTS` was duplicated privately
//! in both `risk-oracle/src/storage.rs` and `event-registry/src/lib.rs`,
//! and `AGGREGATE_SLOTS_7D`, `MAX_CURE_EPOCHS`, the Depeg missing-epoch
//! tolerance default, and the `challenge_secs` bound each lived as a
//! private constant or bare literal in one contract's own crate. Both
//! crates now import these from here instead.

use crate::network_limits::CONTRACT_DATA_ENTRY_SIZE_BYTES;

/// Number of slots in the per asset hourly ring buffer: the longest
/// v1 depeg window (72h) plus the 7 day liquidity baseline before it,
/// at the default `epoch_secs` of 1 hour. technical-doc.md Section
/// 5.8. Frozen for v1, not a governance parameter: changing it would
/// require re-encoding every asset's existing `Ring(asset)` entry,
/// which is a migration, not a parameter change.
pub const RING_SLOTS: u32 = 240;

/// Epochs the 24 hour and 7 day score aggregates look back, and the
/// slots `median_liquidity` uses: the newest 168 of the ring's 240
/// slots. technical-doc.md Section 6.5, 11.1.
pub const AGGREGATE_SLOTS_7D: u32 = 168;

/// The largest number of cure-window epochs (`challenge_secs /
/// EPOCH_SECS`) a Depeg `EventDefinition` may register, 72 hours'
/// worth. Keeps `CureProgress`'s own `recorded: u128` bitmap
/// comfortably sized for every definition this build can register,
/// with headroom to spare. technical-doc.md Section 8.8, PR #15
/// review finding F3.
pub const MAX_CURE_EPOCHS: u64 = 72;

/// `EventDefinition.max_missing_epochs`'s own documented default for
/// a Depeg definition: 6 of the 72 window epochs may be missing
/// without failing the check. technical-doc.md Section 8.2, ADR-005,
/// Section 23 `max_missing_epochs` default.
pub const DEPEG_MISSING_EPOCH_TOLERANCE_DEFAULT: u32 = 6;

/// `challenge_secs` must be a whole number of epochs, at least one
/// epoch long. technical-doc.md Section 8.8, PR #15 review finding
/// F3.
pub const CHALLENGE_SECS_MIN_EPOCHS: u64 = 1;

/// `challenge_secs` must be at most `MAX_CURE_EPOCHS` epochs long, so
/// `CureProgress`'s `u128` bitmap always has room for every cure-window
/// epoch a registered definition could need. technical-doc.md Section
/// 8.8, PR #15 review finding F3.
pub const CHALLENGE_SECS_MAX_EPOCHS: u64 = MAX_CURE_EPOCHS;

/// Fixed number of slots in the per asset sub-epoch ring, `Sub(asset)`.
/// technical-doc.md Section 5.9 S3: sized to outlive the worst case a
/// sub-epoch dispute needs (`sub_backfill_secs + signal_dispute_secs +
/// 3,600` seconds, 5 hours at the defaults) on a fixed 300 second
/// grid, `5 * 3,600 / 300 = 60`. Never resized when `sub_epoch_secs`
/// changes: a slower interval uses fewer of these 60 slots per
/// rotation, never spans more wall-clock time.
pub const SUB_RING_SLOTS: u32 = 60;

/// The fixed wall-clock grid `Sub(asset)`'s ring position is anchored
/// to, in seconds: the 5 minute `sub_epoch_secs` floor. technical-doc.md
/// Section 5.9 S3. Every allowed `sub_epoch_secs` value is a multiple
/// of this, so every sub-epoch's own start time always falls exactly
/// on this grid, and a `sub_epoch_secs` change never needs to
/// re-encode `Sub(asset)`.
pub const SUB_EPOCH_GRID_SECS: u64 = 300;

/// `sylox_types::assets::RingSlot`'s own packed width in `risk-oracle`
/// and `Sub(asset)`'s own packed slot width (same encoding, Section
/// 5.9 S3): 112 bytes. Duplicated here as a plain number (not a
/// cross-crate re-export of `risk-oracle::storage::SLOT_BYTES`, which
/// stays private to that module's own packing) purely so the
/// build-time assertions below can check against it without creating
/// a dependency from `sylox_types` back onto `risk-oracle`.
const PACKED_SLOT_BYTES: u64 = 112;

/// The packed ring's header overhead, ahead of the packed slots:
/// layout version (1) + slot count (4) + slot width (4). Mirrors
/// `risk-oracle::storage::HEADER_BYTES`.
const PACKED_HEADER_BYTES: u64 = 9;

/// Build-time check (Section 5.9 S7, bullet 1): the hourly ring still
/// fits `contract_data_entry_size_bytes`. Unaffected by this revision,
/// which does not touch `RING_SLOTS` or the packed slot width; restated
/// here against the shared constants so a future change to either one
/// fails the build instead of silently reintroducing the Phase 1
/// overflow this packing was built to avoid.
const _: () = assert!(
    RING_SLOTS as u64 * PACKED_SLOT_BYTES + PACKED_HEADER_BYTES <= CONTRACT_DATA_ENTRY_SIZE_BYTES
);

/// Build-time check (Section 5.9 S7, bullet 2): `Sub(asset)` fits
/// `contract_data_entry_size_bytes` at its fixed 60 slot size (6,729
/// bytes, about 10.3% of the limit).
const _: () = assert!(
    SUB_RING_SLOTS as u64 * PACKED_SLOT_BYTES + PACKED_HEADER_BYTES
        <= CONTRACT_DATA_ENTRY_SIZE_BYTES
);

/// Build-time check (Section 5.9 S7, bullet 3): the cure window still
/// fits `CureProgress`'s own `u128` bitmap, one bit per cure epoch.
const _: () = assert!(MAX_CURE_EPOCHS <= 128);
