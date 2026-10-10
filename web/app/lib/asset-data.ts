import { riskOracleClient } from "./contracts/risk-oracle";
import { eventRegistryClient } from "./contracts/event-registry";
import { assetDisplayName } from "./contracts/token";
import { riskBandFor } from "./band";
import type { RiskBand } from "@sylox/ui/risk-bands";
import type { RingSlot, SlotState } from "./contracts/risk-oracle";
import type { CoverGate, EventKind } from "./contracts/event-registry";

export const PEG_RATIO_SCALE = 10_000_000; // i128, scale 1e7 (RiskOracle's own doc comment on peg_ratio).
const EPOCH_SECS = 3600; // technical-doc.md Section 23: epoch_secs is frozen at 3600 (1 hour) for v1.

/** A Result<T, {message}> from a generated client, normalized to a plain outcome. */
type SectionResult<T> = { status: "ok"; value: T } | { status: "error"; message: string };

function ok<T>(value: T): SectionResult<T> {
  return { status: "ok", value };
}

function err<T>(e: unknown): SectionResult<T> {
  return { status: "error", message: e instanceof Error ? e.message : String(e) };
}

async function section<T>(fn: () => Promise<T>): Promise<SectionResult<T>> {
  try {
    return ok(await fn());
  } catch (e) {
    return err(e);
  }
}

// ---------------------------------------------------------------------------
// 1. Header
// ---------------------------------------------------------------------------

export interface AssetHeader {
  asset: string;
  code: string;
  homeDomain: string | null;
  /**
   * Null when the contract has no real score yet - `RiskScore.epoch === 0`
   * means `score()` is returning `stale_score()`'s never-scored fallback,
   * whose `band` field is hardcoded to `Band::Normal` (lib.rs's
   * `stale_score`) as a struct-literal placeholder, not a real "Normal"
   * verdict. Showing that band would read as "this asset is healthy",
   * which is not something the contract has actually determined yet.
   *
   * No count of confirmed-vs-required history is shown alongside this -
   * the 7-day baseline length (168) is a Rust constant
   * (score.rs's AGGREGATE_SLOTS_7D), not something any contract read
   * exposes, and approximating it client-side risked a number that could
   * disagree with the contract's own check. A future `history_status`
   * read returning the contract's own numbers is the right fix,
   * tracked for a later contracts change - not approximated here.
   */
  band: RiskBand | null;
  /** 0-100, or null when the contract has no score yet (same `epoch === 0` condition as `band`). */
  score: number | null;
  stale: boolean;
  eventInProgress: boolean;
  eventDeclared: boolean;
}

function codeFromDisplayName(name: string, asset: string): string {
  const [code] = name.split(":");
  return code && code !== name ? code : `${asset.slice(0, 4)}…${asset.slice(-4)}`;
}

async function fetchHeader(
  oracle: ReturnType<typeof riskOracleClient>,
  asset: string,
): Promise<AssetHeader> {
  const [scoreTx, staleTx, inProgressTx, configTx, name] = await Promise.all([
    oracle.score({ asset }),
    oracle.check_stale({ asset }),
    oracle.event_in_progress({ asset }),
    oracle.asset_config({ asset }),
    assetDisplayName(asset),
  ]);

  const scoreResult = scoreTx.result;
  if (scoreResult.isErr()) {
    throw new Error(`RiskOracle.score returned a contract error: ${scoreResult.unwrapErr().message}`);
  }
  const riskScore = scoreResult.unwrap();
  const hasRealScore = riskScore.epoch !== BigInt(0);

  const staleResult = staleTx.result;
  const stale = staleResult.isErr() ? true : staleResult.unwrap();

  const config = configTx.result;

  return {
    asset,
    code: codeFromDisplayName(name, asset),
    homeDomain: config?.home_domain || null,
    band: hasRealScore ? riskBandFor(riskScore.band) : null,
    score: hasRealScore ? riskScore.score : null,
    stale,
    eventInProgress: inProgressTx.result,
    eventDeclared: hasRealScore && riskScore.band.tag === "Event",
  };
}

// ---------------------------------------------------------------------------
// 2. Confirmed / Live
// ---------------------------------------------------------------------------

export interface ConfirmedValue {
  /** The hourly epoch this value belongs to. */
  epoch: bigint;
  pegRatio: number;
  score: number;
  band: RiskBand;
}

/**
 * The newest hour that is still genuinely Pending (now < pending_until):
 * posted, but still inside its dispute window, so not yet Confirmed. Shown
 * separately from Confirmed rather than folded into it - ADR-008 only
 * treats a slot as effectively final once its own pending_until has passed,
 * and this screen holds the same line between "settled" and "can still be
 * challenged."
 */
export interface LatestPendingHour {
  epoch: bigint;
  pegRatio: number;
  /** Ledger timestamp after which this hour becomes Confirmed - from the slot's own pending_until, never a placeholder. */
  pendingUntil: bigint;
}

export async function fetchConfirmed(
  oracle: ReturnType<typeof riskOracleClient>,
  asset: string,
): Promise<{ confirmed: ConfirmedValue | null; latestPending: LatestPendingHour | null }> {
  const [ring, scoreTx] = await Promise.all([
    fetchEffectiveRing(oracle, asset),
    oracle.score({ asset }),
  ]);

  const scoreResult = scoreTx.result;
  if (scoreResult.isErr()) {
    throw new Error(`RiskOracle.score returned a contract error: ${scoreResult.unwrapErr().message}`);
  }
  const riskScore = scoreResult.unwrap();

  // Walk newest-to-oldest (the ring is returned oldest-first) for the
  // newest slot that is effectively Final - this is the hour "score" and
  // "band" above were actually computed from (RiskOracle.score() is
  // itself defined off the newest Final epoch, see lib.rs's score() doc
  // comment), so pairing them here is pairing like with like, not reusing
  // latest() which can point at a still-Pending hour.
  let confirmed: ConfirmedValue | null = null;
  for (let i = ring.length - 1; i >= 0; i--) {
    const slot = ring[i];
    if (slot.effectiveState === "Final") {
      confirmed = {
        epoch: slot.epoch,
        pegRatio: Number(slot.peg_ratio) / PEG_RATIO_SCALE,
        score: riskScore.score,
        band: riskBandFor(riskScore.band),
      };
      break;
    }
  }

  // The newest slot overall, only if it's a real posted hour still inside
  // its own dispute window (genuinely Pending, not yet promoted to
  // effectively Final).
  let latestPending: LatestPendingHour | null = null;
  const newest = ring[ring.length - 1];
  if (newest && newest.state.tag === "Pending" && newest.effectiveState === "Pending") {
    latestPending = {
      epoch: newest.epoch,
      pegRatio: Number(newest.peg_ratio) / PEG_RATIO_SCALE,
      pendingUntil: newest.pending_until,
    };
  }

  return { confirmed, latestPending };
}

/**
 * The v1.5 spec's live(asset) -> Option<(SubEpoch, SignalSet, SlotState)>
 * sub-epoch read isn't on the deployed RiskOracle contract yet (it's
 * being built on a separate branch). This typed interface matches that
 * exact signature so swapping in the real binding later is a one-line
 * change in fetchLive() below, not a redesign of this screen. Until
 * then this always resolves "not deployed" rather than returning any
 * mock numbers, so nothing fake ever reaches the screen.
 */
export interface SubEpoch {
  hour: bigint;
  sub: number;
}

export type LiveValue =
  | { status: "not-deployed" }
  | { status: "none" }
  | { status: "value"; subEpoch: SubEpoch; pegRatio: number; slotState: SlotState["tag"] };

async function fetchLive(_asset: string): Promise<LiveValue> {
  // Swap this body for a real `riskOracleClient().live({ asset })` call
  // (signature: live(asset) -> Option<(SubEpoch, SignalSet, SlotState)>)
  // once that method exists on the deployed contract. Nothing else on
  // this screen needs to change - LiveValue's "value" case already
  // matches the real return shape.
  return { status: "not-deployed" };
}

// ---------------------------------------------------------------------------
// 3. Peg history (ring)
// ---------------------------------------------------------------------------

const RING_SLOTS = 240; // contracts/risk-oracle/src/storage.rs: RING_SLOTS, frozen for v1.

export interface PegHistoryPoint {
  /** Unix seconds (epoch * EPOCH_SECS), the real time axis - never slot index. */
  timestamp: number;
  epoch: bigint;
  /** The EFFECTIVE state (Pending promoted to Final once pending_until has passed), never the raw stored tag. */
  state: SlotState["tag"];
  /** Null for Empty/Pending/Disputed slots - a gap, never a fake 0. */
  pegRatio: number | null;
  /**
   * False for an hour before the asset's own `first_epoch` - the window
   * always spans the full RING_SLOTS hours regardless of how long the
   * asset has actually existed, so a leading stretch of `Empty` can mean
   * either "before this asset was added" or "a real gap happened here."
   * Only `first_epoch` tells them apart. An untracked hour is never
   * counted as `missing` by the chart's legend - the keeper didn't fail
   * to post something that was never trackable in the first place - and
   * is drawn as a plain unshaded region, not a gap. True when
   * `first_epoch` is unknown (never posted) or its read failed, so a
   * failure here falls back to treating every hour as tracked (today's
   * behavior) rather than guessing which ones aren't.
   */
  tracked: boolean;
}

export interface EffectiveRingSlot extends RingSlot {
  /** `storage::effective_state`'s result for this slot, via RiskOracle.effective_window - the contract's own Pending-to-Final promotion rule, never reimplemented client-side. */
  effectiveState: SlotState["tag"];
}

/**
 * `ring()` returns slots oldest-first, but a never-written slot's stored
 * `epoch` is 0 (storage.rs's `empty_slot()` default) - using it directly
 * for the time axis puts empty hours in 1970. The ring's own layout
 * (storage.rs's `get_ring`: positions `newest_index+1 .. newest_index`,
 * wrapping) means array index `i` always corresponds to real epoch
 * `newestEpoch - (RING_SLOTS - 1) + i`, regardless of what any individual
 * slot's stored epoch says - so the axis is derived from the newest
 * epoch and position alone, never from a per-slot epoch field.
 *
 * `newestEpoch` itself is anchored on whichever array index actually
 * holds the newest non-Empty slot, not assumed to be the last index -
 * the newest hour can itself be Empty (ADR-005: an overturned slot
 * returns to Empty for reposting), in which case the real newest slot
 * sits earlier in the array and every derived epoch must be computed
 * from ITS index, or the whole axis is off by a constant amount.
 *
 * Paired here with `effective_window`, the contract's own read for
 * whether a Pending slot's dispute window has already elapsed
 * (ADR-008/review item C5) - the only Final/not-Final rule this screen
 * uses, never `now >= pending_until` reimplemented client-side.
 */
export async function fetchEffectiveRing(
  oracle: ReturnType<typeof riskOracleClient>,
  asset: string,
): Promise<EffectiveRingSlot[]> {
  const ringTx = await oracle.ring({ asset });
  const slots: RingSlot[] = ringTx.result;

  // The newest non-Empty slot isn't necessarily at the last array index -
  // if the newest hour was overturned and reopened (ADR-005: an
  // overturned slot returns to Empty for reposting), the array's last
  // slot can itself be Empty while an earlier one is real. Anchoring on
  // that slot's own index (not an assumed "last position") is what keeps
  // the derived axis correct in that case: newestEpoch = slot[j].epoch +
  // (RING_SLOTS - 1 - j), for whichever index j actually holds it.
  let anchorIndex = -1;
  for (let i = slots.length - 1; i >= 0; i--) {
    if (slots[i].state.tag !== "Empty") {
      anchorIndex = i;
      break;
    }
  }
  if (anchorIndex === -1) {
    // Never posted: no real epoch to anchor the axis to. Every slot stays
    // Empty; the axis values are arbitrary since nothing will render as a
    // point anyway (every pegRatio comes out null for an all-Empty ring).
    return slots.map((slot) => ({ ...slot, effectiveState: "Empty" }));
  }

  const anchorSlot = slots[anchorIndex];
  const newestEpoch = anchorSlot.epoch + BigInt(RING_SLOTS - 1 - anchorIndex);
  const oldestEpoch =
    newestEpoch >= BigInt(RING_SLOTS - 1) ? newestEpoch - BigInt(RING_SLOTS - 1) : BigInt(0);

  const windowTx = await oracle.effective_window({
    asset,
    start_epoch: oldestEpoch,
    count: RING_SLOTS,
  });
  const effectiveStates = windowTx.result; // Array<SlotState | undefined>, indexed by (epoch - oldestEpoch).

  return slots.map((slot, i) => {
    const epoch = newestEpoch - BigInt(RING_SLOTS - 1) + BigInt(i);
    const windowIndex = Number(epoch - oldestEpoch);
    const effective = effectiveStates[windowIndex];
    return {
      ...slot,
      epoch, // Overrides the raw stored epoch (0 for an unwritten slot) with the derived, always-correct one.
      effectiveState: effective ? effective.tag : "Empty",
    };
  });
}

/** `first_epoch()`'s result, or undefined on ANY failure (rejection or a synchronous throw) - "treat every hour as tracked" rather than guessing. */
async function tryFetchFirstEpoch(
  oracle: ReturnType<typeof riskOracleClient>,
  asset: string,
): Promise<bigint | undefined> {
  try {
    const tx = await oracle.first_epoch({ asset });
    return tx.result;
  } catch {
    return undefined;
  }
}

export async function fetchPegHistory(
  oracle: ReturnType<typeof riskOracleClient>,
  asset: string,
): Promise<PegHistoryPoint[]> {
  // A separate first_epoch() call (the header makes its own too) so this
  // section keeps failing independently of the header - and so a failure
  // here specifically can fall back to "treat every hour as tracked"
  // rather than taking down the whole chart.
  const [ring, firstEpoch] = await Promise.all([
    fetchEffectiveRing(oracle, asset),
    tryFetchFirstEpoch(oracle, asset),
  ]);

  return ring.map((slot) => ({
    timestamp: Number(slot.epoch) * EPOCH_SECS,
    epoch: slot.epoch,
    state: slot.effectiveState,
    // Only an EFFECTIVELY Final slot's peg_ratio is settled and
    // trustworthy - a Pending slot still inside its dispute window,
    // a Disputed slot, or a missing (Empty) one all render as gaps
    // (null), never as 0. A missing or still-contested hour must never
    // be drawn as a depeg dip (technical-doc.md Section 5.8: missing
    // epochs "count neither for nor against" anything the contract
    // itself checks; this screen holds the same rule for what it draws).
    pegRatio: slot.effectiveState === "Final" ? Number(slot.peg_ratio) / PEG_RATIO_SCALE : null,
    tracked: firstEpoch === undefined ? true : slot.epoch >= firstEpoch,
  }));
}

// ---------------------------------------------------------------------------
// 4. Failure definitions (plain words)
// ---------------------------------------------------------------------------

export interface FailureDefinition {
  kind: EventKind["tag"];
  /** Plain-language sentence built only from the contract's own fields - no hardcoded numbers. */
  sentence: string;
}

const EVENT_KINDS: EventKind["tag"][] = [
  "Depeg",
  "IssuerFreeze",
  "MintWithoutBacking",
  "WithdrawalHalt",
  "Insolvency",
];

export function sentenceFor(
  kind: EventKind["tag"],
  def: NonNullable<Awaited<ReturnType<typeof fetchOneDefinition>>>,
): string {
  switch (kind) {
    case "Depeg": {
      const threshold = Number(def.depeg_threshold) / PEG_RATIO_SCALE;
      const hours = Number(def.depeg_window_secs) / 3600;
      return `Depeg: below ${threshold.toFixed(2)} of peg for ${hours} hours, up to ${def.max_missing_epochs} missing hours allowed.`;
    }
    case "IssuerFreeze": {
      const pct = def.freeze_pct_bps / 100;
      return `Issuer freeze: clawbacks or authorization revocations above ${pct}% of supply within 7 days, or more than ${def.auth_revocation_threshold} revocations in that window.`;
    }
    case "MintWithoutBacking": {
      const pct = def.mint_spike_bps / 100;
      return `Mint without backing: a supply increase of more than ${pct}% without matching reserves.`;
    }
    case "WithdrawalHalt": {
      const hours = Number(def.halt_window_secs) / 3600;
      return `Withdrawal halt: the issuer's redemption endpoint reports Down or Degraded for ${hours} hours.`;
    }
    case "Insolvency": {
      return `Insolvency: declared directly by governance, no automatic threshold.`;
    }
  }
}

async function fetchOneDefinition(
  registry: ReturnType<typeof eventRegistryClient>,
  asset: string,
  kind: EventKind["tag"],
) {
  // definition() needs an explicit version; current_version() gives the
  // canonical one to ask for.
  const versionTx = await registry.current_version({ asset, kind: { tag: kind, values: undefined } });
  const version = versionTx.result;
  if (version === 0) return null; // No canonical definition registered for this kind yet.

  const defTx = await registry.definition({
    asset,
    kind: { tag: kind, values: undefined },
    version,
  });
  return defTx.result ?? null;
}

async function fetchFailureDefinitions(
  registry: ReturnType<typeof eventRegistryClient>,
  asset: string,
): Promise<FailureDefinition[]> {
  const results = await Promise.all(
    EVENT_KINDS.map(async (kind) => {
      const def = await fetchOneDefinition(registry, asset, kind);
      if (!def) return null;
      return { kind, sentence: sentenceFor(kind, def) };
    }),
  );
  return results.filter((d): d is FailureDefinition => d !== null);
}

// ---------------------------------------------------------------------------
// 5. Cover sales status
// ---------------------------------------------------------------------------

const COVER_GATE_LABEL: Record<CoverGate["tag"], string> = {
  Clear: "Cover can be sold.",
  EventInProgress: "Sales paused: an event is being challenged for this asset.",
  RecentDepeg: "Sales paused: the price was below the threshold in the last depeg window.",
  RecentEndpointOutage: "Sales paused: the issuer's redemption endpoint was recently down or degraded.",
  RecentIssuerAction: "Sales paused: a clawback or authorization revocation happened in the last 7 days.",
  UnbuiltBacklog: "Sales paused: too many unbuilt hours in the depeg window to scan safely.",
};

/**
 * Not just `cover_gate` - `Series.buy_cover`'s real step 2 (technical-
 * doc.md Section 9.4) rejects if the asset is stale OR its band is
 * Distress/Event, OR `cover_gate` is not Clear (the sequence diagram:
 * `Series->>Oracle: is_stale(asset), band(asset)` happens before
 * `Series->>Registry: cover_gate(asset)`, and either can reject on its
 * own). `cover_gate` alone only covers the EventRegistry-side checks
 * (event-in-progress, recent depeg/outage/issuer-action); showing "Cover
 * can be sold" from that alone would claim a sale would go through when
 * staleness or a Distress/Event band would still reject it.
 */
export type CoverSalesStatus =
  | { gate: "Clear"; label: string }
  | { gate: "Stale"; label: string }
  | { gate: "Distressed"; label: string }
  | { gate: CoverGate["tag"]; label: string };

export async function fetchCoverGate(
  oracle: ReturnType<typeof riskOracleClient>,
  registry: ReturnType<typeof eventRegistryClient>,
  asset: string,
): Promise<CoverSalesStatus> {
  const [staleTx, scoreTx, gateTx] = await Promise.all([
    oracle.check_stale({ asset }),
    oracle.score({ asset }),
    registry.cover_gate({ asset }),
  ]);

  const staleResult = staleTx.result;
  const stale = staleResult.isErr() ? true : staleResult.unwrap();
  if (stale) {
    return { gate: "Stale", label: "Sales paused: not enough price history yet." };
  }

  const scoreResult = scoreTx.result;
  if (scoreResult.isErr()) {
    throw new Error(`RiskOracle.score returned a contract error: ${scoreResult.unwrapErr().message}`);
  }
  const band = scoreResult.unwrap().band.tag;
  if (band === "Distress" || band === "Event") {
    return { gate: "Distressed", label: "Sales paused: the asset is in distress." };
  }

  const gateResult = gateTx.result;
  if (gateResult.isErr()) {
    throw new Error(`EventRegistry.cover_gate returned a contract error: ${gateResult.unwrapErr().message}`);
  }
  const gate = gateResult.unwrap();
  return { gate: gate.tag, label: COVER_GATE_LABEL[gate.tag] };
}

// ---------------------------------------------------------------------------
// 6. Active event
// ---------------------------------------------------------------------------

export interface ActiveEvents {
  count: number;
  /** The specific event ids currently InProgress, one per kind that has one - for linking straight to each from the Asset screen's active-event card. active_event_count() alone only gives a number, never which event(s); event_status(asset, kind) is checked per kind (same EVENT_KINDS list fetchFailureDefinitions already walks) to find them. */
  eventIds: bigint[];
}

async function fetchActiveEventCount(
  registry: ReturnType<typeof eventRegistryClient>,
  asset: string,
): Promise<ActiveEvents> {
  const [countTx, statuses] = await Promise.all([
    registry.active_event_count({ asset }),
    Promise.all(
      EVENT_KINDS.map((kind) => registry.event_status({ asset, kind: { tag: kind, values: undefined } })),
    ),
  ]);

  const eventIds = statuses
    .map((tx) => tx.result)
    .filter((status) => status.tag === "InProgress")
    .map((status) => status.values[0]);

  return { count: countTx.result, eventIds };
}

// ---------------------------------------------------------------------------
// Assembled page data - every section independently failable.
// ---------------------------------------------------------------------------

export interface AssetPageData {
  header: SectionResult<AssetHeader>;
  confirmed: SectionResult<{ confirmed: ConfirmedValue | null; latestPending: LatestPendingHour | null }>;
  live: SectionResult<LiveValue>;
  pegHistory: SectionResult<PegHistoryPoint[]>;
  failureDefinitions: SectionResult<FailureDefinition[]>;
  coverGate: SectionResult<CoverSalesStatus>;
  activeEventCount: SectionResult<ActiveEvents>;
}

export async function fetchAssetPageData(asset: string): Promise<AssetPageData> {
  const oracle = riskOracleClient();
  const registry = eventRegistryClient();

  const [header, confirmed, live, pegHistory, failureDefinitions, coverGate, activeEventCount] =
    await Promise.all([
      section(() => fetchHeader(oracle, asset)),
      section(() => fetchConfirmed(oracle, asset)),
      section(() => fetchLive(asset)),
      section(() => fetchPegHistory(oracle, asset)),
      section(() => fetchFailureDefinitions(registry, asset)),
      section(() => fetchCoverGate(oracle, registry, asset)),
      section(() => fetchActiveEventCount(registry, asset)),
    ]);

  return { header, confirmed, live, pegHistory, failureDefinitions, coverGate, activeEventCount };
}
