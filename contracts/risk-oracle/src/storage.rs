//! Storage keys and the per asset ring buffer. technical-doc.md Section 5.8,
//! 15.1.
//!
//! The ring is stored as one packed `Bytes` blob, not a `Vec<RingSlot>`.
//! A `Vec` of `#[contracttype]` structs encodes each `RingSlot` as an XDR
//! map of named fields, which measured about 440 bytes per slot (105,732
//! bytes for 240 slots), 61% over the current `contract_data_entry_size_bytes`
//! limit of 65,536 (see the PR's Phase 1 report). Packing each slot into
//! fixed width fields with no field names gets one slot down to
//! `SLOT_BYTES` (112, padded from 106 used bytes), 26,880 bytes of slot
//! data for 240 slots (plus the header below), comfortably under the
//! limit. This is the "Storing each slot as a contracttype map with field
//! names would be several times larger" note in Section 5.8, made
//! concrete.
//!
//! `epoch % RING_SLOTS` gives a slot's POSITION, never its identity. A
//! position can hold a slot from any epoch congruent to it mod
//! `RING_SLOTS`, or nothing at all (never written, or overturned and not
//! yet reposted). Every read that wants epoch `e`'s slot must check that
//! the slot stored at `e % RING_SLOTS` actually has `epoch == e`; if it
//! does not (wrong epoch or state `Empty`), epoch `e` is MISSING, counted
//! by `max_missing_epochs` (ADR-005), never read as if it were present.
//! `get_slot` and `get_window` below are the only ways Phase 2 code should
//! read a slot; neither returns a slot whose stored epoch does not match
//! the one asked for.

use soroban_sdk::{contracttype, Address, Bytes, BytesN, Env, Vec};
use sylox_types::{AssetConfig, EndpointStatus, RingSlot, RiskScore, SignalSet, SlotState};

use crate::score::Formula;

/// Number of slots in the per asset ring buffer: the longest v1 depeg
/// window (72h) plus the 7 day liquidity baseline before it, at the
/// default `epoch_secs` of 1 hour. technical-doc.md Section 5.8.
///
/// Frozen for v1, not a governance parameter: changing it would require
/// re-encoding every asset's existing `Ring(asset)` entry (see the header
/// layout version below), which is a migration, not a parameter change.
/// See the PR's "Spec deviations" section.
pub const RING_SLOTS: u32 = 240;

/// Packed width of one `RingSlot`, in bytes:
/// epoch (8) + state (1) + pending_until (8) + peg_ratio (16) +
/// liquidity_2pct (16) + redemption_net (16) + supply (16) +
/// supply_change_bps (4) + clawback_amount (16) + auth_revocations (4) +
/// endpoint (1) = 106. Rounded up to 112 (multiple of 16) so every field
/// of every slot starts at an offset that is cheap to compute; the 6 bytes
/// of padding per slot cost 1,440 bytes across the whole buffer, far less
/// than the gap to the next size class.
///
/// Frozen for v1 alongside `RING_SLOTS`: both are baked into the header
/// below, and a mismatch is rejected rather than silently reinterpreted.
pub const SLOT_BYTES: u32 = 112;

/// Packed ring layout version. Bump this and handle the old layout
/// explicitly (migrate or reject) before ever changing `RING_SLOTS` or
/// `SLOT_BYTES`, or the byte offsets below.
const LAYOUT_VERSION: u8 = 1;

/// Header: `[0] layout version, [1..5) RING_SLOTS, [5..9) SLOT_BYTES`,
/// little endian. `HEADER_BYTES` of overhead ahead of the packed slots so
/// a future reader can detect and refuse an incompatible buffer instead of
/// misreading it as slot data.
const HEADER_BYTES: u32 = 9;

#[contracttype]
pub enum DataKey {
    Asset(Address),
    Signals(Address, u64),
    Ring(Address),
    /// Newest epoch successfully written to `Ring(asset)`, so `get_ring`
    /// can report "oldest first" without scanning for it.
    RingNewest(Address),
    Score(Address),
    /// `(asset, down_streak)` hysteresis counter alongside `Score(asset)`,
    /// kept separate so bumping it on every epoch that fails to move the
    /// band down does not require rewriting the whole `RiskScore`.
    DownStreak(Address),
    /// Dispute record only; the bond itself lives in `Staking` under
    /// `BondKey::SignalDispute` (Section 4.5, 7.8).
    Dispute(Address, u64),
    Assets,
    Formula,
}

#[contracttype]
#[derive(Clone, Eq, PartialEq)]
pub struct DisputeRecord {
    pub disputer: Address,
    pub alt_hash: BytesN<32>,
}

pub fn get_asset_config(env: &Env, asset: &Address) -> Option<AssetConfig> {
    env.storage()
        .persistent()
        .get(&DataKey::Asset(asset.clone()))
}

pub fn set_asset_config(env: &Env, asset: &Address, cfg: &AssetConfig) {
    env.storage()
        .persistent()
        .set(&DataKey::Asset(asset.clone()), cfg);
}

pub fn get_signals(env: &Env, asset: &Address, epoch: u64) -> Option<SignalSet> {
    env.storage()
        .persistent()
        .get(&DataKey::Signals(asset.clone(), epoch))
}

pub fn set_signals(env: &Env, asset: &Address, epoch: u64, signals: &SignalSet) {
    env.storage()
        .persistent()
        .set(&DataKey::Signals(asset.clone(), epoch), signals);
}

/// Returns epoch `epoch`'s slot, or `None` if that epoch is missing: never
/// written, overturned and not yet reposted, or the position has since
/// been overwritten by a different epoch (the ring wrapped around it).
/// Decodes exactly one slot's bytes out of the buffer, not the whole
/// buffer, per the PR's "decode only the slots you need" requirement.
///
/// This is the one place slot identity is checked: every other read in
/// this module (and every Phase 2 caller) goes through this function
/// instead of indexing the packed buffer by position directly.
pub fn get_slot(env: &Env, asset: &Address, epoch: u64) -> Option<RingSlot> {
    let packed = get_ring_packed(env, asset);
    let index = position_of(epoch);
    let slot = read_slot(&packed, index);
    if slot.state != SlotState::Empty && slot.epoch == epoch {
        Some(slot)
    } else {
        None
    }
}

/// Returns the slots for `[start_epoch, start_epoch + count)`, in epoch
/// order, missing epochs included as `None`. Decodes only `count` slots.
/// `count` must be at most `RING_SLOTS`; a caller asking for a window
/// wider than the buffer would silently alias the same position to two
/// different requested epochs, which is a caller bug, not a storage
/// concern, so this panics rather than returning wrong data.
pub fn get_window(
    env: &Env,
    asset: &Address,
    start_epoch: u64,
    count: u32,
) -> Vec<Option<RingSlot>> {
    assert!(
        count <= RING_SLOTS,
        "window of {count} exceeds RING_SLOTS ({RING_SLOTS}); every position would be read more than once"
    );
    let packed = get_ring_packed(env, asset);
    let mut out = Vec::new(env);
    for i in 0..count {
        let epoch = start_epoch + i as u64;
        let slot = read_slot(&packed, position_of(epoch));
        if slot.state != SlotState::Empty && slot.epoch == epoch {
            out.push_back(Some(slot));
        } else {
            out.push_back(None);
        }
    }
    out
}

/// technical-doc.md Section 12.1: `ring(asset) -> Vec<RingSlot>`, "oldest
/// first, one storage read". Decodes every position (this is the one
/// public read that legitimately wants the whole buffer), but still
/// verifies each slot's stored epoch against the epoch that position is
/// currently expected to hold, so a caller of this function never gets a
/// stale or foreign slot either. "Oldest first" means positions
/// `[newest_position + 1 .. RING_SLOTS)` then `[0 ..= newest_position]`,
/// i.e. chronological order starting just after the most recently written
/// slot; an asset that has never posted returns `RING_SLOTS` `Empty`
/// slots in position order (there is no "oldest" yet).
pub fn get_ring(env: &Env, asset: &Address) -> Vec<RingSlot> {
    let packed = get_ring_packed(env, asset);
    let newest = get_newest_epoch(env, asset);

    let mut ring = Vec::new(env);
    match newest {
        Some(newest_epoch) => {
            let newest_index = position_of(newest_epoch);
            for step in 1..=RING_SLOTS {
                let index = (newest_index + step) % RING_SLOTS;
                ring.push_back(verified_slot_at(&packed, index));
            }
        }
        None => {
            for index in 0..RING_SLOTS {
                ring.push_back(verified_slot_at(&packed, index));
            }
        }
    }
    ring
}

/// Reads the slot physically stored at `index` and returns it only if its
/// stored epoch actually maps back to `index` (`position_of(slot.epoch) ==
/// index`); otherwise returns an `Empty` slot. Guards against a corrupted
/// or stale read being mistaken for real data at a position whose true
/// occupant does not match.
fn verified_slot_at(packed: &Bytes, index: u32) -> RingSlot {
    let slot = read_slot(packed, index);
    if slot.state != SlotState::Empty && position_of(slot.epoch) == index {
        slot
    } else {
        empty_slot()
    }
}

/// Tracks the newest epoch written so far, so `get_ring` can report
/// "oldest first" without scanning the buffer for it. Kept as its own
/// entry alongside the packed buffer rather than inside it, so a header
/// version bump never has to account for it.
fn get_newest_epoch(env: &Env, asset: &Address) -> Option<u64> {
    env.storage()
        .persistent()
        .get(&DataKey::RingNewest(asset.clone()))
}

/// Public form of `get_newest_epoch`, for `lib.rs` (`latest`, `score`,
/// `is_stale`, `median_liquidity` all need the newest posted epoch).
pub fn get_newest_epoch_pub(env: &Env, asset: &Address) -> Option<u64> {
    get_newest_epoch(env, asset)
}

/// Writes `signals` for `epoch` into its ring slot at `position_of(epoch)`
/// and persists the whole packed buffer in one storage write.
/// technical-doc.md Section 5.3 step 4, 5.8.
///
/// Refuses to overwrite a position that currently holds a strictly newer
/// epoch than `epoch`: the ring has wrapped exactly once since `epoch`'s
/// position was last written by something newer, which can only happen if
/// `epoch` is being posted far too late (`post_signals`'s window check in
/// `lib.rs` should have already rejected it) or out of order. Returns
/// `false` in that case instead of writing, so the caller can turn it into
/// the right error rather than silently corrupting a newer slot.
pub fn write_ring_slot(
    env: &Env,
    asset: &Address,
    epoch: u64,
    signals: &SignalSet,
    pending_until: u64,
) -> bool {
    let mut packed = get_ring_packed(env, asset);
    let index = position_of(epoch);
    let existing = read_slot(&packed, index);
    if existing.state != SlotState::Empty && existing.epoch > epoch {
        return false;
    }

    let slot = RingSlot {
        epoch,
        state: SlotState::Pending,
        pending_until,
        peg_ratio: signals.peg_ratio,
        liquidity_2pct: signals.liquidity_2pct,
        redemption_net: signals.redemption_net,
        supply: signals.supply,
        supply_change_bps: signals.supply_change_bps,
        clawback_amount: signals.issuer_actions.clawback_amount,
        auth_revocations: signals.issuer_actions.auth_revocations,
        endpoint: signals.endpoint,
    };
    write_slot(&mut packed, index, &slot);
    env.storage()
        .persistent()
        .set(&DataKey::Ring(asset.clone()), &packed);

    let newest = get_newest_epoch(env, asset);
    if newest.is_none_or(|n| epoch > n) {
        env.storage()
            .persistent()
            .set(&DataKey::RingNewest(asset.clone()), &epoch);
    }
    true
}

// -- score --

pub fn get_score(env: &Env, asset: &Address) -> Option<RiskScore> {
    env.storage()
        .persistent()
        .get(&DataKey::Score(asset.clone()))
}

pub fn set_score(env: &Env, asset: &Address, score: &RiskScore) {
    env.storage()
        .persistent()
        .set(&DataKey::Score(asset.clone()), score);
}

pub fn get_down_streak(env: &Env, asset: &Address) -> u32 {
    env.storage()
        .persistent()
        .get(&DataKey::DownStreak(asset.clone()))
        .unwrap_or(0)
}

pub fn set_down_streak(env: &Env, asset: &Address, streak: u32) {
    if streak == 0 {
        env.storage()
            .persistent()
            .remove(&DataKey::DownStreak(asset.clone()));
    } else {
        env.storage()
            .persistent()
            .set(&DataKey::DownStreak(asset.clone()), &streak);
    }
}

// -- formula --

pub fn get_formula(env: &Env) -> Option<Formula> {
    env.storage().instance().get(&DataKey::Formula)
}

pub fn set_formula(env: &Env, formula: &Formula) {
    env.storage().instance().set(&DataKey::Formula, formula);
}

// -- asset list --

pub fn get_assets(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&DataKey::Assets)
        .unwrap_or_else(|| Vec::new(env))
}

pub fn add_to_asset_list(env: &Env, asset: &Address) {
    let mut assets = get_assets(env);
    if !assets.contains(asset) {
        assets.push_back(asset.clone());
        env.storage().instance().set(&DataKey::Assets, &assets);
    }
}

// -- signal disputes --

pub fn get_dispute(env: &Env, asset: &Address, epoch: u64) -> Option<DisputeRecord> {
    env.storage()
        .persistent()
        .get(&DataKey::Dispute(asset.clone(), epoch))
}

pub fn set_dispute(env: &Env, asset: &Address, epoch: u64, record: &DisputeRecord) {
    env.storage()
        .persistent()
        .set(&DataKey::Dispute(asset.clone(), epoch), record);
}

pub fn clear_dispute(env: &Env, asset: &Address, epoch: u64) {
    env.storage()
        .persistent()
        .remove(&DataKey::Dispute(asset.clone(), epoch));
}

/// Sets a ring slot's state directly, for `resolve_signal_dispute`
/// (Section 5.4): `Final` on a keeper win, `Empty` (reopened) on an
/// overturn. Does not touch `RingNewest`: an overturned slot going back
/// to `Empty` should not move the "newest" pointer backwards, and a
/// keeper-wins `Final` transition does not change which epoch is newest
/// either, since the epoch itself is unchanged.
pub fn set_slot_state(env: &Env, asset: &Address, epoch: u64, state: SlotState) {
    let mut packed = get_ring_packed(env, asset);
    let index = position_of(epoch);
    let mut slot = read_slot(&packed, index);
    if slot.epoch != epoch {
        // Nothing to transition; the slot this epoch used to occupy has
        // already been overwritten by something newer. A dispute
        // resolution arriving this late is a timing issue for the caller
        // to handle, not something storage can retroactively fix.
        return;
    }
    slot.state = state;
    if state == SlotState::Empty {
        slot = empty_slot();
    }
    write_slot(&mut packed, index, &slot);
    env.storage()
        .persistent()
        .set(&DataKey::Ring(asset.clone()), &packed);
}

/// Updates a slot's `endpoint` in place, for `finalize_endpoint` (Section
/// 7.4) booking a late `Staking.aggregate` result after `post_signals`
/// had already written `Unknown`. A no-op if the slot's stored epoch no
/// longer matches `epoch` (same reasoning as `set_slot_state`).
pub fn set_slot_endpoint(env: &Env, asset: &Address, epoch: u64, endpoint: EndpointStatus) {
    let mut packed = get_ring_packed(env, asset);
    let index = position_of(epoch);
    let mut slot = read_slot(&packed, index);
    if slot.epoch != epoch {
        return;
    }
    slot.endpoint = endpoint;
    write_slot(&mut packed, index, &slot);
    env.storage()
        .persistent()
        .set(&DataKey::Ring(asset.clone()), &packed);
}

/// `epoch`'s position in the ring. A position, not an identity: see the
/// module doc comment.
fn position_of(epoch: u64) -> u32 {
    (epoch % RING_SLOTS as u64) as u32
}

fn get_ring_packed(env: &Env, asset: &Address) -> Bytes {
    match env
        .storage()
        .persistent()
        .get::<_, Bytes>(&DataKey::Ring(asset.clone()))
    {
        Some(packed) => {
            validate_header(&packed);
            packed
        }
        None => empty_ring_packed(env),
    }
}

fn validate_header(packed: &Bytes) {
    let mut header = [0u8; HEADER_BYTES as usize];
    packed.slice(0..HEADER_BYTES).copy_into_slice(&mut header);
    let version = header[0];
    let slots = u32::from_le_bytes(header[1..5].try_into().unwrap());
    let slot_bytes = u32::from_le_bytes(header[5..9].try_into().unwrap());
    assert!(
        version == LAYOUT_VERSION && slots == RING_SLOTS && slot_bytes == SLOT_BYTES,
        "ring buffer layout mismatch: stored version {version}, RING_SLOTS {slots}, SLOT_BYTES {slot_bytes}; \
         this build expects version {LAYOUT_VERSION}, RING_SLOTS {RING_SLOTS}, SLOT_BYTES {SLOT_BYTES}"
    );
}

fn empty_ring_packed(env: &Env) -> Bytes {
    let mut header = [0u8; HEADER_BYTES as usize];
    header[0] = LAYOUT_VERSION;
    header[1..5].copy_from_slice(&RING_SLOTS.to_le_bytes());
    header[5..9].copy_from_slice(&SLOT_BYTES.to_le_bytes());

    let mut packed = Bytes::from_slice(env, &header);
    let zeros = [0u8; SLOT_BYTES as usize];
    for _ in 0..RING_SLOTS {
        packed.extend_from_slice(&zeros);
    }
    packed
}

fn empty_slot() -> RingSlot {
    RingSlot {
        epoch: 0,
        state: SlotState::Empty,
        pending_until: 0,
        peg_ratio: 0,
        liquidity_2pct: 0,
        redemption_net: 0,
        supply: 0,
        supply_change_bps: 0,
        clawback_amount: 0,
        auth_revocations: 0,
        endpoint: EndpointStatus::Unknown,
    }
}

fn state_byte(state: SlotState) -> u8 {
    match state {
        SlotState::Empty => 0,
        SlotState::Pending => 1,
        SlotState::Disputed => 2,
        SlotState::Final => 3,
    }
}

fn byte_state(b: u8) -> SlotState {
    match b {
        1 => SlotState::Pending,
        2 => SlotState::Disputed,
        3 => SlotState::Final,
        _ => SlotState::Empty,
    }
}

fn endpoint_byte(status: EndpointStatus) -> u8 {
    match status {
        EndpointStatus::Unknown => 0,
        EndpointStatus::Up => 1,
        EndpointStatus::Degraded => 2,
        EndpointStatus::Down => 3,
    }
}

fn byte_endpoint(b: u8) -> EndpointStatus {
    match b {
        1 => EndpointStatus::Up,
        2 => EndpointStatus::Degraded,
        3 => EndpointStatus::Down,
        _ => EndpointStatus::Unknown,
    }
}

/// Byte offset of slot `index`'s first byte, past the header.
fn slot_base(index: u32) -> u32 {
    HEADER_BYTES + index * SLOT_BYTES
}

/// Writes one slot's fields into `packed` at `index`, fixed width, no field
/// names. Layout (little endian) within the slot, 106 of its 112 bytes
/// used: `[0..8) epoch, [8) state, [9..17) pending_until, [17..33)
/// peg_ratio, [33..49) liquidity_2pct, [49..65) redemption_net, [65..81)
/// supply, [81..85) supply_change_bps, [85..101) clawback_amount,
/// [101..105) auth_revocations, [105) endpoint`.
fn write_slot(packed: &mut Bytes, index: u32, slot: &RingSlot) {
    let base = slot_base(index);
    let mut buf = [0u8; SLOT_BYTES as usize];
    buf[0..8].copy_from_slice(&slot.epoch.to_le_bytes());
    buf[8] = state_byte(slot.state);
    buf[9..17].copy_from_slice(&slot.pending_until.to_le_bytes());
    buf[17..33].copy_from_slice(&slot.peg_ratio.to_le_bytes());
    buf[33..49].copy_from_slice(&slot.liquidity_2pct.to_le_bytes());
    buf[49..65].copy_from_slice(&slot.redemption_net.to_le_bytes());
    buf[65..81].copy_from_slice(&slot.supply.to_le_bytes());
    buf[81..85].copy_from_slice(&slot.supply_change_bps.to_le_bytes());
    buf[85..101].copy_from_slice(&slot.clawback_amount.to_le_bytes());
    buf[101..105].copy_from_slice(&slot.auth_revocations.to_le_bytes());
    buf[105] = endpoint_byte(slot.endpoint);

    packed.copy_from_slice(base, &buf);
}

/// Reads slot `index`'s fields back out of `packed`. Infallible: every
/// `try_into()` below converts a fixed, known-length sub-slice of a
/// `[u8; SLOT_BYTES as usize]` array into an array of the same length, so
/// none can fail; that invariant is what makes `.unwrap()` here safe
/// rather than a defect, but we still spell out the length relationship
/// explicitly instead of trusting that the reasoning around it won't rot.
fn read_slot(packed: &Bytes, index: u32) -> RingSlot {
    let base = slot_base(index);
    let mut buf = [0u8; SLOT_BYTES as usize];
    packed
        .slice(base..base + SLOT_BYTES)
        .copy_into_slice(&mut buf);

    RingSlot {
        epoch: read_u64(&buf, 0),
        state: byte_state(buf[8]),
        pending_until: read_u64(&buf, 9),
        peg_ratio: read_i128(&buf, 17),
        liquidity_2pct: read_i128(&buf, 33),
        redemption_net: read_i128(&buf, 49),
        supply: read_i128(&buf, 65),
        supply_change_bps: read_i32(&buf, 81),
        clawback_amount: read_i128(&buf, 85),
        auth_revocations: read_u32(&buf, 101),
        endpoint: byte_endpoint(buf[105]),
    }
}

/// Reads 8 bytes at `offset` as a little endian `u64`. `offset + 8` is
/// always within `buf`'s `SLOT_BYTES` bound for every call site above, so
/// this never panics; the array conversion is infallible by construction
/// (fixed length in, fixed length out), not something that can fail at
/// runtime.
fn read_u64(buf: &[u8; SLOT_BYTES as usize], offset: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&buf[offset..offset + 8]);
    u64::from_le_bytes(b)
}

fn read_u32(buf: &[u8; SLOT_BYTES as usize], offset: usize) -> u32 {
    let mut b = [0u8; 4];
    b.copy_from_slice(&buf[offset..offset + 4]);
    u32::from_le_bytes(b)
}

fn read_i32(buf: &[u8; SLOT_BYTES as usize], offset: usize) -> i32 {
    let mut b = [0u8; 4];
    b.copy_from_slice(&buf[offset..offset + 4]);
    i32::from_le_bytes(b)
}

fn read_i128(buf: &[u8; SLOT_BYTES as usize], offset: usize) -> i128 {
    let mut b = [0u8; 16];
    b.copy_from_slice(&buf[offset..offset + 16]);
    i128::from_le_bytes(b)
}

/// Test only: flips the stored layout version so the next read is
/// guaranteed to fail `validate_header`'s check. Exists purely to prove
/// that check fires; production code has no other way to corrupt a
/// `Ring(asset)` entry's header.
#[cfg(test)]
pub fn corrupt_header_for_test(env: &Env, asset: &Address) {
    let packed: Bytes = env
        .storage()
        .persistent()
        .get(&DataKey::Ring(asset.clone()))
        .expect("corrupt_header_for_test: no Ring(asset) entry to corrupt");
    let mut header = [0u8; HEADER_BYTES as usize];
    packed.slice(0..HEADER_BYTES).copy_into_slice(&mut header);
    header[0] = LAYOUT_VERSION + 1;
    let mut corrupted = Bytes::from_slice(env, &header);
    corrupted.append(&packed.slice(HEADER_BYTES..packed.len()));
    env.storage()
        .persistent()
        .set(&DataKey::Ring(asset.clone()), &corrupted);
}
