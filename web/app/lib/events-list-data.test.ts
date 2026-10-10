import { describe, expect, it, vi, beforeEach } from "vitest";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { EventRecordRaw, FetchEventsOptions } from "./stellar-rpc-events";

const { fetchEventsPaginated, assetDisplayName, eventFn, rulingDeadlineFn } = vi.hoisted(() => ({
  fetchEventsPaginated: vi.fn(),
  assetDisplayName: vi.fn(async () => "USDC"),
  eventFn: vi.fn(),
  rulingDeadlineFn: vi.fn(async (): Promise<{ result: bigint | null }> => ({ result: null })),
}));

vi.mock("./stellar-rpc-events", async () => {
  const actual = await vi.importActual<typeof import("./stellar-rpc-events")>("./stellar-rpc-events");
  return { ...actual, fetchEventsPaginated };
});

vi.mock("./contracts/token", () => ({ assetDisplayName }));

vi.mock("./contracts/event-registry", () => ({
  eventRegistryClient: () => ({
    event: eventFn,
    ruling_deadline: rulingDeadlineFn,
  }),
}));

// A real event_proposed log entry's value is a map ScVal with an
// event_id: u64 field - built directly as XDR (rather than via
// nativeToScVal's own struct-type inference, which needs a full spec
// this test has no reason to carry) so scValToNative in the real
// events-list-data.ts decodes it exactly the way a live contract
// event would.
function rawEventFor(eventId: bigint, ledger: number): EventRecordRaw {
  return {
    ledger,
    ledgerClosedAt: new Date(ledger * 1000).toISOString(),
    topic: [],
    value: xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: nativeToScVal("event_id", { type: "symbol" }),
        val: nativeToScVal(eventId, { type: "u64" }),
      }),
    ]),
    id: `evt-${eventId}`,
  };
}

function fakeRecord(eventId: bigint, state: string, asset = "CASSET") {
  return {
    id: eventId,
    asset,
    kind: { tag: "Depeg" },
    state: { tag: state },
    proposed_at: BigInt(1_790_000_000),
  };
}

describe("listRegistryEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assetDisplayName.mockResolvedValue("USDC");
    rulingDeadlineFn.mockResolvedValue({ result: null });
  });

  it("resolves each row's CURRENT state via event(id), not the frozen log entry", async () => {
    const raw = [rawEventFor(BigInt(1), 100)];
    fetchEventsPaginated.mockResolvedValue({
      events: raw,
      oldestLedgerScanned: 90,
      latestLedger: 200,
      latestLedgerCloseTime: 500,
      requestCount: 1,
      stoppedAtRequestCap: false,
    });
    eventFn.mockResolvedValue({ result: fakeRecord(BigInt(1), "Cured") });

    const { listRegistryEvents } = await import("./events-list-data");
    const result = await listRegistryEvents();

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].state).toBe("Cured"); // Not "Proposed" - the log's frozen view.
    expect(eventFn).toHaveBeenCalledWith({ event_id: BigInt(1) });
  });

  it("skips an id whose read comes back with no record, rather than showing a broken row", async () => {
    const raw = [rawEventFor(BigInt(1), 100), rawEventFor(BigInt(2), 90)];
    fetchEventsPaginated.mockResolvedValue({
      events: raw,
      oldestLedgerScanned: 80,
      latestLedger: 200,
      latestLedgerCloseTime: 500,
      requestCount: 1,
      stoppedAtRequestCap: false,
    });
    eventFn.mockImplementation(async ({ event_id }: { event_id: bigint }) =>
      event_id === BigInt(1) ? { result: fakeRecord(BigInt(1), "Proposed") } : { result: null },
    );

    const { listRegistryEvents } = await import("./events-list-data");
    const result = await listRegistryEvents();

    expect(result.rows.map((r) => r.id)).toEqual([BigInt(1)]);
  });

  it("calls onRowProgress with each row as soon as it's resolved, before the whole scan finishes", async () => {
    const raw = [rawEventFor(BigInt(1), 100), rawEventFor(BigInt(2), 90)];
    let capturedOnProgress: ((events: EventRecordRaw[]) => void) | undefined;

    fetchEventsPaginated.mockImplementation(async (_query, options: FetchEventsOptions) => {
      capturedOnProgress = options.onProgress;
      // Simulate the underlying scan reporting the first raw event as
      // its own chunk lands, well before the scan (and this mocked
      // call) resolves.
      options.onProgress?.([raw[0]]);
      await Promise.resolve();
      options.onProgress?.(raw);
      return {
        events: raw,
        oldestLedgerScanned: 80,
        latestLedger: 200,
        latestLedgerCloseTime: 500,
        requestCount: 2,
        stoppedAtRequestCap: false,
      };
    });
    eventFn.mockImplementation(async ({ event_id }: { event_id: bigint }) => ({
      result: fakeRecord(event_id, "Proposed"),
    }));

    const { listRegistryEvents } = await import("./events-list-data");
    const progressRowIds: bigint[] = [];
    const result = await listRegistryEvents({ onRowProgress: (row) => progressRowIds.push(row.id) });

    expect(capturedOnProgress).toBeDefined();
    // Both ids were reported via onRowProgress at some point during the scan...
    expect(new Set(progressRowIds)).toEqual(new Set([BigInt(1), BigInt(2)]));
    // ...and the final, resolved result still has the complete, correct row set.
    expect(result.rows.map((r) => r.id).sort()).toEqual([BigInt(1), BigInt(2)].sort());
  });

  it("never reads the same id's current state twice, even though onProgress reports overlapping lists repeatedly", async () => {
    const raw = [rawEventFor(BigInt(1), 100)];
    fetchEventsPaginated.mockImplementation(async (_query, options: FetchEventsOptions) => {
      // The real scan's onProgress fires with the FULL events-so-far
      // list after every chunk - calling it twice with the same
      // single event simulates that overlap.
      options.onProgress?.(raw);
      options.onProgress?.(raw);
      return {
        events: raw,
        oldestLedgerScanned: 80,
        latestLedger: 200,
        latestLedgerCloseTime: 500,
        requestCount: 1,
        stoppedAtRequestCap: false,
      };
    });
    eventFn.mockResolvedValue({ result: fakeRecord(BigInt(1), "Proposed") });

    const { listRegistryEvents } = await import("./events-list-data");
    await listRegistryEvents({ onRowProgress: () => {} });

    expect(eventFn).toHaveBeenCalledTimes(1);
  });

  it("reads ruling_deadline for an Escalated event's countdown, and nothing extra for a closed one", async () => {
    const raw = [rawEventFor(BigInt(1), 100), rawEventFor(BigInt(2), 90)];
    fetchEventsPaginated.mockResolvedValue({
      events: raw,
      oldestLedgerScanned: 80,
      latestLedger: 200,
      latestLedgerCloseTime: 500,
      requestCount: 1,
      stoppedAtRequestCap: false,
    });
    eventFn.mockImplementation(async ({ event_id }: { event_id: bigint }) =>
      event_id === BigInt(1)
        ? { result: fakeRecord(BigInt(1), "Escalated") }
        : { result: fakeRecord(BigInt(2), "Cured") },
    );
    rulingDeadlineFn.mockResolvedValue({ result: BigInt(1_800_000_000) });

    const { listRegistryEvents } = await import("./events-list-data");
    const result = await listRegistryEvents();

    const escalated = result.rows.find((r) => r.id === BigInt(1));
    const cured = result.rows.find((r) => r.id === BigInt(2));
    expect(escalated?.windowClosesAt).toBe(BigInt(1_800_000_000));
    expect(cured?.windowClosesAt).toBeNull();
    expect(rulingDeadlineFn).toHaveBeenCalledTimes(1); // Only for the Escalated row.
  });

  it("forwards oldestLedgerScanned, latestLedger, and stoppedAtRequestCap straight from the scan", async () => {
    fetchEventsPaginated.mockResolvedValue({
      events: [],
      oldestLedgerScanned: 12_345,
      latestLedger: 99_999,
      latestLedgerCloseTime: 500,
      requestCount: 1,
      stoppedAtRequestCap: true,
    });

    const { listRegistryEvents } = await import("./events-list-data");
    const result = await listRegistryEvents();

    expect(result.oldestLedgerScanned).toBe(12_345);
    expect(result.latestLedger).toBe(99_999);
    expect(result.stoppedAtRequestCap).toBe(true);
    expect(result.rows).toEqual([]);
  });
});
