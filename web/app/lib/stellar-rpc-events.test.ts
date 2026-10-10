import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * A fake RPC whose retention floor moves forward a few ledgers on
 * every getHealth() call - exactly the real-time drift this module's
 * FLOOR_MARGIN exists to stay clear of (see stellar-rpc-events.ts's
 * top doc comment). Also lets a test simulate the rare case where a
 * chunk's request still lands out of range despite the margin, to
 * exercise the one bounded retry, and lets `latestLedger` be advanced
 * mid-test to simulate new ledgers closing between two calls (for the
 * incremental-refresh tests).
 */
function makeFakeServer(opts: {
  latestLedger: number;
  initialOldestLedger: number;
  driftPerHealthCall: number;
  /** Ledgers, keyed by ledger number, that have a fake event. */
  eventLedgers: number[];
  /** If true, the FIRST getEvents call for each distinct range fails with the out-of-range error (simulating drift catching a chunk mid-flight), succeeding only on retry. */
  failFirstAttempt?: boolean;
}) {
  let oldestLedger = opts.initialOldestLedger;
  let latestLedger = opts.latestLedger;
  let healthCallCount = 0;
  let getEventsCallCount = 0;
  const failedOnce = new Set<string>();

  return {
    getHealth: vi.fn(async () => {
      healthCallCount++;
      const result = {
        status: "healthy" as const,
        latestLedger,
        oldestLedger,
        ledgerRetentionWindow: latestLedger - oldestLedger,
      };
      oldestLedger += opts.driftPerHealthCall; // The floor keeps moving, like the real RPC.
      return result;
    }),
    getEvents: vi.fn(async (request: { startLedger?: number; endLedger?: number; cursor?: string }) => {
      getEventsCallCount++;
      if (request.cursor) {
        throw new Error("unexpected cursor-based follow-up request in this fake");
      }

      const { startLedger, endLedger } = request;
      if (startLedger === undefined || endLedger === undefined) {
        throw new Error("fake server expects startLedger/endLedger");
      }

      const rangeKey = `${startLedger}-${endLedger}`;
      if (opts.failFirstAttempt && !failedOnce.has(rangeKey)) {
        failedOnce.add(rangeKey);
        throw { code: -32600, message: `startLedger must be within the ledger range: ${oldestLedger} - ${latestLedger}` };
      }
      if (startLedger < oldestLedger) {
        throw { code: -32600, message: `startLedger must be within the ledger range: ${oldestLedger} - ${latestLedger}` };
      }

      const matching = opts.eventLedgers.filter((l) => l >= startLedger && l < endLedger);
      const events = matching.map((ledger) => ({
        ledger,
        ledgerClosedAt: new Date(ledger * 1000).toISOString(),
        topic: [],
        value: {},
        id: `event-${ledger}`,
      }));

      const cursorLedger = endLedger - 1;
      return {
        events,
        cursor: `${BigInt(cursorLedger) << BigInt(32)}-4294967295`,
        latestLedger,
        oldestLedger,
        latestLedgerCloseTime: String(latestLedger * 5),
        oldestLedgerCloseTime: String(oldestLedger * 5),
      };
    }),
    advanceLatestLedger(by: number) {
      latestLedger += by;
    },
    addEventLedger(ledger: number) {
      opts.eventLedgers.push(ledger);
    },
    get callCounts() {
      return { healthCallCount, getEventsCallCount };
    },
  };
}

const { fakeServerInstance, ServerMock } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fake's real shape is defined below makeFakeServer, which this hoisted block runs before (vi.hoisted semantics).
  const state: { instance: any } = { instance: null };
  class FakeServerConstructor {
    constructor() {
      return state.instance;
    }
  }
  return { fakeServerInstance: state, ServerMock: FakeServerConstructor };
});

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual<typeof import("@stellar/stellar-sdk")>("@stellar/stellar-sdk");
  return { ...actual, rpc: { ...actual.rpc, Server: ServerMock } };
});

const TEST_QUERY = { contractId: "CTEST", topics: ["sylox", "event_proposed", "*"] };

describe("fetchEventsPaginated (backward-chunked scan, incrementally cached)", () => {
  beforeEach(() => {
    vi.resetModules();
    sessionStorage.clear();
  });

  it("finds the newest events in the first chunk when history is recent", async () => {
    const fake = makeFakeServer({
      latestLedger: 100_000,
      initialOldestLedger: 100_000 - 120_960,
      driftPerHealthCall: 1,
      eventLedgers: [99_950, 99_960], // Well inside the first 10,000-ledger chunk.
    });
    fakeServerInstance.instance = fake as never;

    const { fetchEventsPaginated } = await import("./stellar-rpc-events");
    const result = await fetchEventsPaginated({ ...TEST_QUERY, limit: 2 });

    expect(result.events.map((e) => e.ledger)).toEqual([99_960, 99_950]); // Newest first.
    expect(result.requestCount).toBeLessThanOrEqual(3);
    expect(result.stoppedAtRequestCap).toBe(false);
  });

  it("walks back through multiple chunks when history is older, still finishing within the request cap", async () => {
    const fake = makeFakeServer({
      latestLedger: 100_000,
      initialOldestLedger: 100_000 - 120_960,
      driftPerHealthCall: 1,
      eventLedgers: [100_000 - 25_000], // ~3 chunks back at CHUNK_SIZE=10,000.
    });
    fakeServerInstance.instance = fake as never;

    const { fetchEventsPaginated } = await import("./stellar-rpc-events");
    const result = await fetchEventsPaginated({ ...TEST_QUERY, limit: 1 });

    expect(result.events).toHaveLength(1);
    expect(result.events[0].ledger).toBe(100_000 - 25_000);
    expect(result.requestCount).toBeLessThanOrEqual(6); // ~3 chunks, not the full ~13-chunk window.
    expect(result.stoppedAtRequestCap).toBe(false);
  });

  it("recovers via the one bounded retry when a chunk lands out of range due to floor drift", async () => {
    const fake = makeFakeServer({
      latestLedger: 100_000,
      initialOldestLedger: 100_000 - 120_960,
      driftPerHealthCall: 50,
      eventLedgers: [99_990],
      failFirstAttempt: true,
    });
    fakeServerInstance.instance = fake as never;

    const { fetchEventsPaginated } = await import("./stellar-rpc-events");
    const result = await fetchEventsPaginated({ ...TEST_QUERY, limit: 50 });

    expect(result.events.map((e) => e.ledger)).toContain(99_990);
    expect(fake.callCounts.healthCallCount).toBeGreaterThanOrEqual(2); // Initial + the one retry's re-fetch.
  });

  it("returns what it has (not an error) if it hits the request cap before the limit or the floor", async () => {
    const fake = makeFakeServer({
      latestLedger: 1_000_000,
      initialOldestLedger: 0, // A window far wider than REQUEST_CAP * CHUNK_SIZE can cover.
      driftPerHealthCall: 0,
      eventLedgers: [], // Nothing anywhere - forces the scan to walk every chunk until the cap.
    });
    fakeServerInstance.instance = fake as never;

    const { fetchEventsPaginated } = await import("./stellar-rpc-events");
    const result = await fetchEventsPaginated({ ...TEST_QUERY, limit: 50 });

    expect(result.events).toEqual([]);
    expect(result.stoppedAtRequestCap).toBe(true);
    // The cap is checked between chunks, not mid-chunk, so a chunk
    // already in flight when the cap is reached can finish its own
    // (bounded, <=5) internal pages first - this asserts the backstop
    // is still genuinely a backstop (no unbounded growth), not that
    // it's exactly 20.
    expect(result.requestCount).toBeLessThanOrEqual(20 + 5);
  });

  it("a second call with no new ledgers is fully warm - just the one getHealth() call", async () => {
    const fake = makeFakeServer({
      latestLedger: 100_000,
      initialOldestLedger: 100_000 - 120_960,
      driftPerHealthCall: 0, // No drift, so "no new ledgers" is exact between the two calls.
      eventLedgers: [99_990],
    });
    fakeServerInstance.instance = fake as never;

    const { fetchEventsPaginated } = await import("./stellar-rpc-events");
    const first = await fetchEventsPaginated({ ...TEST_QUERY, limit: 50 });
    expect(first.requestCount).toBeGreaterThan(1); // The cold scan.

    const eventsCallsBeforeSecond = fake.callCounts.getEventsCallCount;
    const second = await fetchEventsPaginated({ ...TEST_QUERY, limit: 50 });

    expect(second.events).toEqual(first.events);
    expect(second.requestCount).toBe(1); // Just getHealth() - already fully covered up to latestLedger.
    expect(fake.callCounts.getEventsCallCount).toBe(eventsCallsBeforeSecond); // No new getEvents calls at all.
  });

  it("an incremental refresh after new ledgers close only scans the new slice, merging with the cached events", async () => {
    const fake = makeFakeServer({
      latestLedger: 100_000,
      initialOldestLedger: 100_000 - 120_960,
      driftPerHealthCall: 0,
      eventLedgers: [99_990],
    });
    fakeServerInstance.instance = fake as never;

    const { fetchEventsPaginated } = await import("./stellar-rpc-events");
    const first = await fetchEventsPaginated({ ...TEST_QUERY, limit: 50 });
    expect(first.events.map((e) => e.ledger)).toEqual([99_990]);

    // Simulate time passing: new ledgers close, and a new event lands in them.
    fake.advanceLatestLedger(500);
    fake.addEventLedger(100_400);

    const second = await fetchEventsPaginated({ ...TEST_QUERY, limit: 50 });

    // Both the old (cached) and new event are present, newest first -
    // the old one was never re-scanned, only merged in from cache.
    expect(second.events.map((e) => e.ledger)).toEqual([100_400, 99_990]);
    expect(second.latestLedger).toBe(100_500);
  });

  it("drops a cached event once its ledger ages below the moving floor", async () => {
    // FLOOR_MARGIN=100, so the effective floor is initialOldestLedger+100.
    const fake = makeFakeServer({
      latestLedger: 100_000,
      initialOldestLedger: 99_000, // Effective floor starts at 99_100.
      driftPerHealthCall: 0,
      eventLedgers: [99_150], // Comfortably inside the floor for the first call.
    });
    fakeServerInstance.instance = fake as never;

    const { fetchEventsPaginated } = await import("./stellar-rpc-events");
    const first = await fetchEventsPaginated({ ...TEST_QUERY, limit: 50 });
    expect(first.events.map((e) => e.ledger)).toEqual([99_150]);

    // The retention floor moves forward past the cached event's ledger.
    fakeServerInstance.instance.getHealth = vi.fn(async () => ({
      status: "healthy" as const,
      latestLedger: 100_000,
      oldestLedger: 99_200, // Effective floor now 99_300, past the cached event at 99_150.
      ledgerRetentionWindow: 800,
    }));

    const second = await fetchEventsPaginated({ ...TEST_QUERY, limit: 50 });
    expect(second.events.map((e) => e.ledger)).not.toContain(99_150);
  });

  it("calls onProgress after EVERY chunk during a cold scan, not just once at the end", async () => {
    const fake = makeFakeServer({
      latestLedger: 100_000,
      initialOldestLedger: 100_000 - 30_000,
      driftPerHealthCall: 0,
      // Nothing found until the 3rd chunk back, and no limit that
      // could let the scan stop early - forces it to walk all 3
      // chunks in this window, so onProgress firing only once (at the
      // very end) vs. once per chunk is actually distinguishable.
      eventLedgers: [100_000 - 25_000],
    });
    fakeServerInstance.instance = fake as never;

    const { fetchEventsPaginated } = await import("./stellar-rpc-events");
    const progressCalls: number[][] = [];
    await fetchEventsPaginated(
      { ...TEST_QUERY, limit: 50 },
      { onProgress: (events) => progressCalls.push(events.map((e) => e.ledger)) },
    );

    // 3 chunks back at CHUNK_SIZE=10,000 over a 30,000-ledger window -
    // one onProgress call per chunk, landing before the scan as a
    // whole resolves.
    expect(progressCalls.length).toBe(3);
    // The first two chunks found nothing yet; only the third (oldest)
    // chunk actually contains the event - onProgress's own snapshots
    // reflect that growth chunk by chunk, not just the final state
    // repeated three times.
    expect(progressCalls[0]).toEqual([]);
    expect(progressCalls[1]).toEqual([]);
    expect(progressCalls[2]).toEqual([100_000 - 25_000]);
  });

  it("persists across a fresh module import (simulating a page reload) via sessionStorage", async () => {
    const fake = makeFakeServer({
      latestLedger: 100_000,
      initialOldestLedger: 100_000 - 120_960,
      driftPerHealthCall: 0,
      eventLedgers: [99_990],
    });
    fakeServerInstance.instance = fake as never;

    const mod1 = await import("./stellar-rpc-events");
    await mod1.fetchEventsPaginated({ ...TEST_QUERY, limit: 50 });

    // A fresh module instance (vi.resetModules clears the in-memory
    // Map) still finds the cached state, because it was mirrored into
    // sessionStorage, which a real page reload doesn't clear either.
    vi.resetModules();
    const eventsCallsBeforeReload = fake.callCounts.getEventsCallCount;
    const mod2 = await import("./stellar-rpc-events");
    const afterReload = await mod2.fetchEventsPaginated({ ...TEST_QUERY, limit: 50 });

    expect(afterReload.events.map((e) => e.ledger)).toEqual([99_990]);
    expect(fake.callCounts.getEventsCallCount).toBe(eventsCallsBeforeReload); // No new getEvents call needed - sessionStorage already had it.
  });

  it("replaces (never merges onto) the cache when an incremental refresh itself stops at the request cap before reaching the old cache's floor", async () => {
    const fake = makeFakeServer({
      latestLedger: 100_000,
      initialOldestLedger: 100_000 - 120_960,
      driftPerHealthCall: 0,
      eventLedgers: [99_990],
    });
    fakeServerInstance.instance = fake as never;

    const { fetchEventsPaginated } = await import("./stellar-rpc-events");
    const first = await fetchEventsPaginated({ ...TEST_QUERY, limit: 50 });
    expect(first.events.map((e) => e.ledger)).toEqual([99_990]);

    // New ledgers close - far more of them than REQUEST_CAP * CHUNK_SIZE
    // can cover in one incremental refresh (cap=20, chunk=10,000 -> a
    // 500,000-ledger-wide new slice forces the refresh itself to stop
    // at the cap well before it reaches back down to the old cache's
    // floor, cached.latestLedgerCovered+1). A new event lands just
    // inside the part of that new slice the refresh DOES reach.
    fake.advanceLatestLedger(500_000);
    fake.addEventLedger(599_995);

    const second = await fetchEventsPaginated({ ...TEST_QUERY, limit: 50 });

    // The new event (within the freshly-scanned range) is present;
    // the old cached event at 99_990 is NOT, because the gap between
    // where this refresh stopped and the old cache's floor was never
    // actually scanned - merging it back in would falsely claim that
    // gap as covered.
    expect(second.events.map((e) => e.ledger)).toEqual([599_995]);
    expect(second.stoppedAtRequestCap).toBe(true);
  });

  it("replaces (never merges onto) the cache when an incremental refresh stops at its OWN event limit before reaching the old cache's floor, even though the request cap was never hit", async () => {
    const fake = makeFakeServer({
      latestLedger: 100_000,
      initialOldestLedger: 100_000 - 120_960,
      driftPerHealthCall: 0,
      eventLedgers: [99_990],
    });
    fakeServerInstance.instance = fake as never;

    const { fetchEventsPaginated } = await import("./stellar-rpc-events");
    const first = await fetchEventsPaginated({ ...TEST_QUERY, limit: 50 });
    expect(first.events.map((e) => e.ledger)).toEqual([99_990]);

    // New ledgers close, with enough new events packed into the very
    // first new chunk that the incremental refresh's own `limit: 1`
    // below is satisfied immediately - it stops right there (well
    // under REQUEST_CAP=20 requests, so stoppedAtRequestCap would be
    // false if that were still the only trigger), long before
    // reaching back down to the old cache's floor.
    fake.advanceLatestLedger(20_000);
    fake.addEventLedger(119_999);
    fake.addEventLedger(119_998);

    const second = await fetchEventsPaginated({ ...TEST_QUERY, limit: 1 });

    // Only the newest event (from the freshly-scanned slice) comes
    // back - the old cached event at 99_990 is correctly dropped,
    // because the gap between where this refresh stopped (having
    // satisfied its own limit) and the old cache's floor was never
    // actually scanned. The result still honestly reports that more
    // history wasn't scanned, even though REQUEST_CAP itself was
    // never approached.
    expect(second.events.map((e) => e.ledger)).toEqual([119_999]);
    expect(second.stoppedAtRequestCap).toBe(true);
    expect(fake.callCounts.healthCallCount + fake.callCounts.getEventsCallCount).toBeLessThan(20);
  });

  it("keys the sessionStorage cache by contract id, so a different contract never serves another's events", async () => {
    const fake = makeFakeServer({
      latestLedger: 100_000,
      initialOldestLedger: 100_000 - 120_960,
      driftPerHealthCall: 0,
      eventLedgers: [99_990],
    });
    fakeServerInstance.instance = fake as never;

    const { fetchEventsPaginated } = await import("./stellar-rpc-events");
    await fetchEventsPaginated({ ...TEST_QUERY, contractId: "CONE", limit: 50 });
    const otherContractResult = await fetchEventsPaginated({ ...TEST_QUERY, contractId: "CTWO", limit: 50 });

    // CTWO has never been scanned - this is its own cold scan, not CONE's cached result.
    expect(otherContractResult.events.map((e) => e.ledger)).toEqual([99_990]); // Same fake data, but genuinely re-fetched, not reused from CONE's cache key.
  });
});
