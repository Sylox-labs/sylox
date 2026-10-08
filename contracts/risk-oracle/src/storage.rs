//! Storage keys and the per asset ring buffer. technical-doc.md Section 5.8,
//! 15.1. Phase 1 scope only: `AssetConfig`, `Signals(asset, epoch)` and the
//! ring buffer, nothing else.
//!
//! The ring is stored as one packed `Bytes` blob, not a `Vec<RingSlot>`.
//! A `Vec` of `#[contracttype]` structs encodes each `RingSlot` as an XDR
//! map of named fields, which measured about 440 bytes per slot (105,732
//! bytes for 240 slots), 61% over the current `contract_data_entry_size_bytes`
//! limit of 65,536 (see the PR's Phase 1 report). Packing each slot into
//! fixed width fields with no field names gets one slot down to the
//! `SLOT_BYTES` computed below (112, padded from 106 used bytes),
//! 26,880 bytes for 240 slots, comfortably under the limit. This is the
//! "Storing each slot as a contracttype map with field names would be
//! several times larger" note in Section 5.8, made concrete.

use soroban_sdk::{contracttype, Address, Bytes, Env, Vec};
use sylox_types::{AssetConfig, EndpointStatus, RingSlot, SignalSet, SlotState};

/// Number of slots in the per asset ring buffer: the longest v1 depeg
/// window (72h) plus the 7 day liquidity baseline before it, at the
/// default `epoch_secs` of 1 hour. technical-doc.md Section 5.8.
pub const RING_SLOTS: u32 = 240;

/// Packed width of one `RingSlot`, in bytes:
/// epoch (8) + state (1) + pending_until (8) + peg_ratio (16) +
/// liquidity_2pct (16) + redemption_net (16) + supply (16) +
/// supply_change_bps (4) + clawback_amount (16) + auth_revocations (4) +
/// endpoint (1) = 106. Rounded up to 112 (multiple of 16) so every field
/// of every slot starts at an offset that is cheap to compute; the 6 bytes
/// of padding per slot cost 1,440 bytes across the whole buffer, far less
/// than the gap to the next size class.
pub const SLOT_BYTES: u32 = 112;

#[contracttype]
pub enum DataKey {
    Asset(Address),
    Signals(Address, u64),
    Ring(Address),
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

/// Reads and decodes the full ring buffer for `asset`, or `RING_SLOTS`
/// empty slots if the asset has never posted. One storage read, per
/// Section 5.8.
pub fn get_ring(env: &Env, asset: &Address) -> Vec<RingSlot> {
    let packed = get_ring_packed(env, asset);
    decode_ring(env, &packed)
}

/// Writes `signals` for `epoch` into its ring slot at `epoch % RING_SLOTS`
/// and persists the whole packed buffer in one storage write.
/// technical-doc.md Section 5.3 step 4, 5.8.
pub fn write_ring_slot(
    env: &Env,
    asset: &Address,
    epoch: u64,
    signals: &SignalSet,
    pending_until: u64,
) {
    let mut packed = get_ring_packed(env, asset);
    let index = (epoch % RING_SLOTS as u64) as u32;
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
}

fn get_ring_packed(env: &Env, asset: &Address) -> Bytes {
    env.storage()
        .persistent()
        .get(&DataKey::Ring(asset.clone()))
        .unwrap_or_else(|| empty_ring_packed(env))
}

fn empty_ring_packed(env: &Env) -> Bytes {
    Bytes::from_slice(env, &[0u8; (SLOT_BYTES * RING_SLOTS) as usize])
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

/// Writes one slot's fields into `packed` at `index`, fixed width, no field
/// names. Layout (little endian), 106 of the 112 bytes used:
/// `[0..8) epoch, [8) state, [9..17) pending_until, [17..33) peg_ratio,
/// [33..49) liquidity_2pct, [49..65) redemption_net, [65..81) supply,
/// [81..85) supply_change_bps, [85..101) clawback_amount,
/// [101..105) auth_revocations, [105) endpoint`.
fn write_slot(packed: &mut Bytes, index: u32, slot: &RingSlot) {
    let base = index * SLOT_BYTES;
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

fn read_slot(packed: &Bytes, index: u32) -> RingSlot {
    let base = index * SLOT_BYTES;
    let mut buf = [0u8; SLOT_BYTES as usize];
    packed
        .slice(base..base + SLOT_BYTES)
        .copy_into_slice(&mut buf);

    RingSlot {
        epoch: u64::from_le_bytes(buf[0..8].try_into().unwrap()),
        state: byte_state(buf[8]),
        pending_until: u64::from_le_bytes(buf[9..17].try_into().unwrap()),
        peg_ratio: i128::from_le_bytes(buf[17..33].try_into().unwrap()),
        liquidity_2pct: i128::from_le_bytes(buf[33..49].try_into().unwrap()),
        redemption_net: i128::from_le_bytes(buf[49..65].try_into().unwrap()),
        supply: i128::from_le_bytes(buf[65..81].try_into().unwrap()),
        supply_change_bps: i32::from_le_bytes(buf[81..85].try_into().unwrap()),
        clawback_amount: i128::from_le_bytes(buf[85..101].try_into().unwrap()),
        auth_revocations: u32::from_le_bytes(buf[101..105].try_into().unwrap()),
        endpoint: byte_endpoint(buf[105]),
    }
}

fn decode_ring(env: &Env, packed: &Bytes) -> Vec<RingSlot> {
    let mut ring = Vec::new(env);
    for i in 0..RING_SLOTS {
        ring.push_back(read_slot(packed, i));
    }
    ring
}
