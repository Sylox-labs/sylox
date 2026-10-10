/**
 * Plans the backward-walking, half-open ledger ranges a chunked
 * getEvents scan requests, newest-first. Pure and synchronous on
 * purpose: the range math (where does the next chunk start, when does
 * the walk stop) is exactly the part that's easy to get subtly wrong
 * one boundary at a time inside a live async loop - worked out and
 * tested here on its own instead, so the loop that actually calls the
 * RPC (lib/stellar-rpc-events.ts) stays a thin "for each range, fetch
 * it" with nothing left to tune by feel.
 *
 * Every range is `[start, end)`: start inclusive, end exclusive -
 * confirmed empirically that getEvents' own endLedger is exclusive
 * (see web/app/README.md's "RPC getEvents pagination" section). Two
 * adjacent planned ranges always share their boundary exactly (one's
 * `start` equals the next one's `end`), so there is never a gap or an
 * overlap between them by construction.
 *
 * A fixed chunk size, not a growing one: an earlier version of this
 * tried doubling the chunk size for a sparse/empty topic, on the
 * assumption that a wider requested range costs the same ~1 request
 * as a narrow one. Measured directly against the real RPC, that's
 * false - a single getEvents call only ever advances its cursor by
 * about CHUNK_LEDGERS_PER_REQUEST ledgers REGARDLESS of how wide a
 * range is requested (confirmed at 2,000/16,000/32,000/64,000-ledger
 * requests: each needed cursor-following to finish, at roughly the
 * same ~10,000 ledgers of real progress per request). A bigger
 * `endLedger` doesn't buy a bigger single-request scan, so growth
 * bought nothing - it only meant more partially-wasted internal pages
 * per "chunk." Fixed-size chunks that match the RPC's own real per-
 * request scan distance is both simpler and just as fast.
 */
export interface LedgerRange {
  /** Inclusive. */
  start: number;
  /** Exclusive. */
  end: number;
}

/**
 * @param latestLedger The newest ledger to start scanning from (inclusive of this ledger - the first range's `end` is `latestLedger + 1`).
 * @param floor The oldest ledger willing to be scanned (inclusive) - callers pass a safety margin above the RPC's own retention floor here, not the floor itself (see fetchEventsPaginated's doc comment for why).
 * @param chunkSize Ledgers per range, at most.
 * @returns Ranges newest-first, covering exactly `[floor, latestLedger]` with no gap or overlap, stopping the moment it reaches `floor`. Empty if `latestLedger < floor`.
 */
export function planChunks(latestLedger: number, floor: number, chunkSize: number): LedgerRange[] {
  if (chunkSize <= 0) throw new Error(`chunkSize must be positive, got ${chunkSize}`);
  if (latestLedger < floor) return [];

  const ranges: LedgerRange[] = [];
  let end = latestLedger + 1;
  while (end > floor) {
    const start = Math.max(floor, end - chunkSize);
    ranges.push({ start, end });
    end = start;
  }
  return ranges;
}
