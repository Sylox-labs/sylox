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
  band: RiskBand;
  /** 0-100, or null when the contract has no score yet. */
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

  const staleResult = staleTx.result;
  const stale = staleResult.isErr() ? true : staleResult.unwrap();

  const config = configTx.result;

  return {
    asset,
    code: codeFromDisplayName(name, asset),
    homeDomain: config?.home_domain || null,
    band: riskBandFor(riskScore.band),
    score: riskScore.epoch === BigInt(0) ? null : riskScore.score,
    stale,
    eventInProgress: inProgressTx.result,
    eventDeclared: riskScore.band.tag === "Event",
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

async function fetchConfirmed(
  oracle: ReturnType<typeof riskOracleClient>,
  asset: string,
): Promise<ConfirmedValue | null> {
  const [latestTx, scoreTx] = await Promise.all([oracle.latest({ asset }), oracle.score({ asset })]);

  const latest = latestTx.result;
  if (!latest) return null;

  const scoreResult = scoreTx.result;
  if (scoreResult.isErr()) {
    throw new Error(`RiskOracle.score returned a contract error: ${scoreResult.unwrapErr().message}`);
  }
  const riskScore = scoreResult.unwrap();

  return {
    epoch: latest.epoch,
    pegRatio: Number(latest.peg_ratio) / PEG_RATIO_SCALE,
    score: riskScore.score,
    band: riskBandFor(riskScore.band),
  };
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

export interface PegHistoryPoint {
  /** Unix seconds (epoch * EPOCH_SECS), the real time axis - never slot index. */
  timestamp: number;
  epoch: bigint;
  state: SlotState["tag"];
  /** Null for Empty/Pending/Disputed slots - a gap, never a fake 0. */
  pegRatio: number | null;
}

async function fetchPegHistory(
  oracle: ReturnType<typeof riskOracleClient>,
  asset: string,
): Promise<PegHistoryPoint[]> {
  const ringTx = await oracle.ring({ asset });
  const slots: RingSlot[] = ringTx.result;

  return slots.map((slot) => ({
    timestamp: Number(slot.epoch) * EPOCH_SECS,
    epoch: slot.epoch,
    state: slot.state.tag,
    // Only a Final slot's peg_ratio is a settled, trustworthy value.
    // Pending/Disputed/Empty all render as gaps (null), never as 0 -
    // a missing or still-contested hour must never be drawn as a
    // depeg dip (technical-doc.md Section 5.8: missing epochs "count
    // neither for nor against" anything the contract itself checks;
    // this screen holds the same rule for what it draws).
    pegRatio: slot.state.tag === "Final" ? Number(slot.peg_ratio) / PEG_RATIO_SCALE : null,
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

function sentenceFor(kind: EventKind["tag"], def: NonNullable<Awaited<ReturnType<typeof fetchOneDefinition>>>): string {
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
};

async function fetchCoverGate(
  registry: ReturnType<typeof eventRegistryClient>,
  asset: string,
): Promise<{ gate: CoverGate["tag"]; label: string }> {
  const tx = await registry.cover_gate({ asset });
  const result = tx.result;
  if (result.isErr()) {
    throw new Error(`EventRegistry.cover_gate returned a contract error: ${result.unwrapErr().message}`);
  }
  const gate = result.unwrap();
  return { gate: gate.tag, label: COVER_GATE_LABEL[gate.tag] };
}

// ---------------------------------------------------------------------------
// 6. Active event
// ---------------------------------------------------------------------------

async function fetchActiveEventCount(
  registry: ReturnType<typeof eventRegistryClient>,
  asset: string,
): Promise<number> {
  const tx = await registry.active_event_count({ asset });
  return tx.result;
}

// ---------------------------------------------------------------------------
// Assembled page data - every section independently failable.
// ---------------------------------------------------------------------------

export interface AssetPageData {
  header: SectionResult<AssetHeader>;
  confirmed: SectionResult<ConfirmedValue | null>;
  live: SectionResult<LiveValue>;
  pegHistory: SectionResult<PegHistoryPoint[]>;
  failureDefinitions: SectionResult<FailureDefinition[]>;
  coverGate: SectionResult<{ gate: CoverGate["tag"]; label: string }>;
  activeEventCount: SectionResult<number>;
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
      section(() => fetchCoverGate(registry, asset)),
      section(() => fetchActiveEventCount(registry, asset)),
    ]);

  return { header, confirmed, live, pegHistory, failureDefinitions, coverGate, activeEventCount };
}
