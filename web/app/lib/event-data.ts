import { eventRegistryClient } from "./contracts/event-registry";
import { assetDisplayName } from "./contracts/token";
import { sentenceFor } from "./asset-data";
import type { EventRecord, CureProgress, EventDefinition } from "./contracts/event-registry";

/** A Result<T, {message}> from a generated client, normalized to a plain outcome - same shape as asset-data.ts's SectionResult, kept local since this module has its own independent sections. */
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
// 1. The proposal itself
// ---------------------------------------------------------------------------

export interface EventProposal {
  record: EventRecord;
  assetCode: string;
  /** The plain-language sentence for the specific definition version this event was checked against - never the canonical one, which can have moved on since. */
  definitionSentence: string;
}

async function fetchEventRecord(
  registry: ReturnType<typeof eventRegistryClient>,
  eventId: bigint,
): Promise<EventRecord> {
  const tx = await registry.event({ event_id: eventId });
  const record = tx.result;
  if (!record) throw new Error(`No event found with id ${eventId}.`);
  return record;
}

async function fetchDefinitionByVersion(
  registry: ReturnType<typeof eventRegistryClient>,
  asset: string,
  kind: EventRecord["kind"],
  version: number,
): Promise<EventDefinition> {
  const tx = await registry.definition({ asset, kind, version });
  const def = tx.result;
  if (!def) {
    throw new Error(`No definition found for this event's pinned version (${version}).`);
  }
  return def;
}

async function fetchProposal(
  registry: ReturnType<typeof eventRegistryClient>,
  eventId: bigint,
): Promise<{ proposal: EventProposal; def: EventDefinition }> {
  const record = await fetchEventRecord(registry, eventId);
  const [assetCode, def] = await Promise.all([
    assetDisplayName(record.asset).then((name) => name.split(":")[0] || name),
    fetchDefinitionByVersion(registry, record.asset, record.kind, record.def_version),
  ]);

  return {
    proposal: {
      record,
      assetCode,
      definitionSentence: sentenceFor(record.kind.tag, def),
    },
    def,
  };
}

// ---------------------------------------------------------------------------
// 2. Challenge-window / ruling countdown
// ---------------------------------------------------------------------------

export type CountdownPhase =
  | { phase: "challenge"; deadline: bigint }
  | { phase: "ruling"; deadline: bigint }
  | { phase: "closed" };

/**
 * The real deadline for whatever window the event is currently in -
 * never derived from a RingSlot's pending_until, which belongs to the
 * oracle's own hourly signal lifecycle (Section 5.7), a different
 * clock from the event's own challenge/ruling windows (Section 8.1,
 * 8.3). While Proposed: record.proposed_at + def.challenge_secs,
 * exactly the deadline finalize() itself checks against
 * (ChallengeWindowOpen). While Escalated: the contract's own
 * ruling_deadline(event_id) read (escalated_at + ruling_deadline_secs,
 * lib.rs), never recomputed client-side from escalated_at + a locally
 * held challenge_secs/ruling_deadline_secs that could drift from what
 * the contract actually used if the definition was later superseded.
 */
async function fetchCountdown(
  registry: ReturnType<typeof eventRegistryClient>,
  eventId: bigint,
  record: EventRecord,
  def: EventDefinition,
): Promise<CountdownPhase> {
  if (record.state.tag === "Proposed") {
    return { phase: "challenge", deadline: record.proposed_at + def.challenge_secs };
  }
  if (record.state.tag === "Escalated") {
    const tx = await registry.ruling_deadline({ event_id: eventId });
    const deadline = tx.result;
    if (deadline === undefined) {
      throw new Error("Event is Escalated but the contract has no ruling deadline for it.");
    }
    return { phase: "ruling", deadline };
  }
  return { phase: "closed" };
}

// ---------------------------------------------------------------------------
// 3. Cure progress
// ---------------------------------------------------------------------------

/**
 * checkpoint_cure is permissionless and idempotent (lib.rs's own doc
 * comment), and every generated client method auto-simulates on
 * construction - reading its simulated .result here shows the
 * contract's own current cure-progress record without submitting
 * anything. A real Checkpoint click still calls signAndSend() on this
 * same AssembledTransaction; this fetch is a read, not a hidden write.
 */
async function fetchCureProgress(
  registry: ReturnType<typeof eventRegistryClient>,
  eventId: bigint,
): Promise<CureProgress | null> {
  const tx = await registry.checkpoint_cure({ event_id: eventId });
  const result = tx.result;
  if (result.isErr()) {
    // WrongState (not Proposed/not a Depeg event) isn't a real error to
    // surface - cure progress simply doesn't apply to this event.
    return null;
  }
  return result.unwrap();
}

// ---------------------------------------------------------------------------
// Assembled page data - every section independently failable, matching
// the Asset screen's pattern (lib/asset-data.ts).
// ---------------------------------------------------------------------------

export interface EventPageData {
  proposal: SectionResult<EventProposal>;
  countdown: SectionResult<CountdownPhase>;
  cureProgress: SectionResult<CureProgress | null>;
}

export async function fetchEventPageData(eventId: bigint): Promise<EventPageData> {
  const registry = eventRegistryClient();

  // The record is fetched once, up front, and reused - every other
  // section needs it (kind/asset/state for the countdown and cure
  // progress), and an event's record is immutable in the fields those
  // sections read (id, asset, kind, def_version never change after
  // proposal), so re-fetching it per section would only be extra RPC
  // round trips for identical data, not independent freshness.
  let shared: { proposal: EventProposal; def: EventDefinition } | null = null;
  try {
    shared = await fetchProposal(registry, eventId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      proposal: err(message),
      countdown: err("Could not load the event record."),
      cureProgress: err("Could not load the event record."),
    };
  }

  const [countdown, cureProgress] = await Promise.all([
    section(() => fetchCountdown(registry, eventId, shared!.proposal.record, shared!.def)),
    section(() => fetchCureProgress(registry, eventId)),
  ]);

  return { proposal: ok(shared.proposal), countdown, cureProgress };
}
