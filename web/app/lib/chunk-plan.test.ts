import { describe, expect, it } from "vitest";
import { planChunks, type LedgerRange } from "./chunk-plan";

function assertNoGapOrOverlap(ranges: LedgerRange[], floor: number, latestLedger: number) {
  // Newest-first: each range's end should equal the previous range's start.
  for (let i = 1; i < ranges.length; i++) {
    expect(ranges[i].end).toBe(ranges[i - 1].start);
  }
  // Together they cover exactly [floor, latestLedger] with no gap or overlap.
  if (ranges.length > 0) {
    expect(ranges[0].end).toBe(latestLedger + 1);
    expect(ranges[ranges.length - 1].start).toBe(floor);
  }
  for (const r of ranges) {
    expect(r.start).toBeLessThan(r.end); // Every range is non-empty.
    expect(r.start).toBeGreaterThanOrEqual(floor);
    expect(r.end).toBeLessThanOrEqual(latestLedger + 1);
  }
}

describe("planChunks", () => {
  it("exact multiple of the chunk size", () => {
    // 10 chunks of 1000 exactly: floor=0, latest=9999 -> window is 10000 ledgers.
    const ranges = planChunks(9999, 0, 1000);
    expect(ranges).toHaveLength(10);
    assertNoGapOrOverlap(ranges, 0, 9999);
    expect(ranges[0]).toEqual({ start: 9000, end: 10000 });
    expect(ranges[ranges.length - 1]).toEqual({ start: 0, end: 1000 });
  });

  it("window not a multiple of the chunk size - last range is the remainder", () => {
    // floor=0, latest=9500 -> window is 9501 ledgers over chunks of 1000: 9 full chunks + a 501-ledger remainder.
    const ranges = planChunks(9500, 0, 1000);
    assertNoGapOrOverlap(ranges, 0, 9500);
    expect(ranges[ranges.length - 1]).toEqual({ start: 0, end: 501 });
    expect(ranges[ranges.length - 1].end - ranges[ranges.length - 1].start).toBe(501);
  });

  it("window smaller than one chunk - a single, smaller range", () => {
    const ranges = planChunks(1050, 1000, 2000);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toEqual({ start: 1000, end: 1051 });
    assertNoGapOrOverlap(ranges, 1000, 1050);
  });

  it("latest == floor - a single one-ledger range", () => {
    const ranges = planChunks(5000, 5000, 2000);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toEqual({ start: 5000, end: 5001 });
  });

  it("latest < floor - no ranges at all", () => {
    expect(planChunks(100, 200, 50)).toEqual([]);
  });

  it("adjacent ranges touch exactly, newest first, with no gap or overlap - real-world size", () => {
    // Representative of the real scan: ~120,960 ledgers (7 days), 2000-ledger chunks.
    const latest = 5116000;
    const floor = latest - 120_960;
    const ranges = planChunks(latest, floor, 2000);
    assertNoGapOrOverlap(ranges, floor, latest);
    // 120,961-ledger window / 2000 per chunk -> 61 chunks (60 full + 1 partial).
    expect(ranges).toHaveLength(61);
  });

  it("rejects a non-positive chunk size", () => {
    expect(() => planChunks(100, 0, 0)).toThrow();
    expect(() => planChunks(100, 0, -5)).toThrow();
  });
});
