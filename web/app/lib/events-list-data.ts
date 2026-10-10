import { scValToNative, nativeToScVal } from "@stellar/stellar-sdk";
import { eventRegistryClient } from "./contracts/event-registry";
import { assetDisplayName } from "./contracts/token";
import { fetchEventsPaginated, type FetchEventsOptions } from "./stellar-rpc-events";
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

export async function listRegistryEvents(options: FetchEventsOptions = {}): Promise<EventListResult> {
  const registry = eventRegistryClient();
  const scan = await fetchEventsPaginated(
    {
      contractId: testnetDeployment.contracts.event_registry.id,
      topics: [topicXdr("sylox"), topicXdr("event_proposed"), "*"],
      limit: 50,
    },
    options,
  );

  const eventIds = scan.events.map((raw) => {
    const decoded = scValToNative(raw.value as never) as DecodedEventProposed;
    return decoded.event_id;
  });

  const rows = (await Promise.all(eventIds.map((id) => rowFor(registry, id)))).filter(
    (r): r is EventListRow => r !== null,
  );

  return {
    rows,
    oldestLedgerScanned: scan.oldestLedgerScanned,
    latestLedger: scan.latestLedger,
    stoppedAtRequestCap: scan.stoppedAtRequestCap,
  };
}
