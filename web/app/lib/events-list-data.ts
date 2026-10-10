import { scValToNative, nativeToScVal } from "@stellar/stellar-sdk";
import { eventRegistryClient } from "./contracts/event-registry";
import { assetDisplayName } from "./contracts/token";
import { fetchEventsPaginated, type EventRecordRaw } from "./stellar-rpc-events";
import { testnetDeployment } from "./contracts/deployment";
import type { EventRecord } from "./contracts/event-registry";

/**
 * STOPGAP: EventRegistry doesn't yet expose a direct read listing
 * every event it has ever stored, so this scans the RPC's own event
 * log (event_proposed, Section 13) for event ids, then reads each
 * one's CURRENT state with event(event_id) - the log entry itself is
 * frozen at proposal time, never updated as an event moves through
 * Challenged/Escalated/Cured/Declared/Rejected, so the log alone would
 * show every event stuck at "just proposed."
 *
 * Kept behind this one function so a future direct contract read
 * (tracked for after the markets/governance work that's expected to
 * add proper event enumeration) is a single-function swap for
 * whatever calls this, not a rewrite of the Events screen itself.
 */

export interface EventListRow {
  id: bigint;
  assetCode: string;
  kind: EventRecord["kind"]["tag"];
  state: EventRecord["state"]["tag"];
  proposedAt: bigint;
  /** Seconds remaining in the event's current window, if it's still open - null once Cured/Declared/Rejected. Derived the same way as the Event screen's own countdown (never a RingSlot's pending_until - see lib/event-data.ts). */
  windowClosesAt: bigint | null;
}

export interface EventListResult {
  rows: EventListRow[];
  /** The oldest ledger actually scanned - use this for an honest "Events in the last N days" label, never a fixed 7. */
  oldestLedgerScanned: number;
  latestLedger: number;
  stoppedAtRequestCap: boolean;
}

function topicXdr(symbol: string): string {
  return nativeToScVal(symbol, { type: "symbol" }).toXDR("base64");
}

interface DecodedEventProposed {
  event_id: bigint;
}

async function windowCloseFor(
  registry: ReturnType<typeof eventRegistryClient>,
  record: EventRecord,
): Promise<bigint | null> {
  if (record.state.tag === "Escalated") {
    const tx = await registry.ruling_deadline({ event_id: record.id });
    return tx.result ?? null;
  }
  // A Proposed event's own challenge_secs isn't on EventRecord itself
  // (only on its EventDefinition) - the list row only needs "is this
  // still open," which record.state already answers; the Event
  // screen itself (lib/event-data.ts) is where the full countdown,
  // fetched against the specific pinned definition, belongs.
  return null;
}

async function rowFor(
  registry: ReturnType<typeof eventRegistryClient>,
  eventId: bigint,
): Promise<EventListRow | null> {
  const tx = await registry.event({ event_id: eventId });
  const record = tx.result;
  if (!record) return null; // The log mentioned it, but a read raced ahead/behind - skip rather than show a broken row.

  const [assetCode, windowClosesAt] = await Promise.all([
    assetDisplayName(record.asset).then((name) => name.split(":")[0] || name),
    windowCloseFor(registry, record),
  ]);

  return {
    id: record.id,
    assetCode,
    kind: record.kind.tag,
    state: record.state.tag,
    proposedAt: record.proposed_at,
    windowClosesAt,
  };
}

function eventIdFor(raw: EventRecordRaw): bigint {
  const decoded = scValToNative(raw.value as never) as DecodedEventProposed;
  return decoded.event_id;
}

export interface ListRegistryEventsOptions {
  /**
   * Called with a newly-resolved row as soon as its current state has
   * been read via event(event_id) - not batched until the whole scan
   * finishes. Rows arrive in the same newest-first order the
   * underlying ledger scan finds their ids in, but resolution itself
   * is per-id (not strictly serialized against the scan's own
   * chunking), so a later id can occasionally resolve before an
   * earlier one; the final `rows` from the resolved promise is always
   * the complete, correctly-ordered list regardless. A null row (the
   * log mentioned an id a read then raced past, see rowFor) is never
   * reported - exactly the ids the final result itself filters out.
   */
  onRowProgress?: (row: EventListRow) => void;
}

export async function listRegistryEvents(options: ListRegistryEventsOptions = {}): Promise<EventListResult> {
  const registry = eventRegistryClient();
  // Keyed by event id: the SAME in-flight (or settled) promise every
  // caller of resolveFor awaits, so a row started early by
  // resolveNewIds (below) is never re-fetched by the final batch just
  // because that fetch hadn't settled yet when the scan resolved.
  const inFlight = new Map<string, Promise<EventListRow | null>>();

  const resolveFor = (id: bigint): Promise<EventListRow | null> => {
    const key = id.toString();
    const existing = inFlight.get(key);
    if (existing) return existing;
    const promise = rowFor(registry, id);
    inFlight.set(key, promise);
    return promise;
  };

  const resolveNewIds = (raws: EventRecordRaw[]): void => {
    if (!options.onRowProgress) return;
    for (const raw of raws) {
      const id = eventIdFor(raw);
      if (inFlight.has(id.toString())) continue;
      // Fire-and-forget: resolving a row never blocks the scan itself
      // from walking further chunks, so the newest rows a visitor can
      // already see don't wait on an older, still-in-flight one. A
      // failed read here is never fatal - the final Promise.all below
      // awaits this SAME promise and correctly surfaces a real
      // rejection there, so this only needs to avoid an unhandled
      // rejection, not report the error itself.
      void resolveFor(id)
        .then((row) => {
          if (row !== null) options.onRowProgress?.(row);
        })
        .catch(() => {});
    }
  };

  const scan = await fetchEventsPaginated(
    {
      contractId: testnetDeployment.contracts.event_registry.id,
      topics: [topicXdr("sylox"), topicXdr("event_proposed"), "*"],
      limit: 50,
    },
    { onProgress: resolveNewIds },
  );

  const eventIds = scan.events.map(eventIdFor);
  const rows = (await Promise.all(eventIds.map((id) => resolveFor(id)))).filter(
    (r): r is EventListRow => r !== null,
  );

  return {
    rows,
    oldestLedgerScanned: scan.oldestLedgerScanned,
    latestLedger: scan.latestLedger,
    stoppedAtRequestCap: scan.stoppedAtRequestCap,
  };
}
