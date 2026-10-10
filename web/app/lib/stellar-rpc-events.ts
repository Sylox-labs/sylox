import { rpc } from "@stellar/stellar-sdk";
import { RPC_URL, testnetDeployment } from "./contracts/deployment";
import { planChunks } from "./chunk-plan";

/**
 * RPC getEvents pagination, found by testing directly against our
 * testnet contracts - full writeup in web/app/README.md's "RPC
 * getEvents pagination" section, kept here as the short version next
 * to the code that depends on it:
 *
 * A single getEvents call only advances its cursor by roughly
 * CHUNK_LEDGERS_PER_REQUEST ledgers, REGARDLESS of how wide a range
 * was requested or whether endLedger bounds it tighter - it does not
 * error when it stops short, it just returns whatever it found (zero,
 * for a quiet slice) together with a cursor pointing just past where
 * it stopped. A wider requested chunk does NOT mean fewer requests -
 * measured directly: 2,000/16,000/32,000/64,000-ledger requests all
 * advanced the cursor by about the same ~10,000 ledgers per actual
 * request, meaning a 64,000-ledger chunk still needed 7 requests
 * (cursor-followed) to fully cover. This is why CHUNK_SIZE below is
 * fixed at that same real per-request distance, not grown for a
 * sparse topic (an earlier version tried growth and found it bought
 * nothing - see chunk-plan.ts's doc comment).
 *
 * Because getEvents only pages FORWARD (oldest cursor -> newest), and
 * the list this feeds needs newest-first, this walks whole CHUNK_SIZE-
 * ledger ranges backward from latestLedger toward the retention floor
 * (endLedger bounds each chunk precisely - confirmed EXCLUSIVE against
 * the real RPC), until either `limit` events are collected or the
 * floor is reached.
 *
 * The retention floor itself moves forward in real time (about one
 * ledger every 5-6 seconds) while a multi-chunk scan runs, so a single
 * getHealth() snapshot taken at the top can go stale by the time a
 * later chunk's request fires. Measured drift during a real scan is a
 * handful of ledgers at most, and only the LAST chunk (the one
 * nearest the floor) is ever at risk - so rather than chasing the
 * floor, FLOOR_MARGIN stays clear of it: the scan treats
 * `oldestLedger + FLOOR_MARGIN` as the floor, giving up the oldest
 * ~8-10 minutes of the window, which nothing here needs. A single
 * bounded retry (re-fetch getHealth, re-clamp, try once more) is kept
 * as a safety net for the rare case a request still lands out of
 * range; if that also fails, the scan stops and returns whatever it
 * already has rather than retrying in a loop - REQUEST_CAP is the
 * hard backstop for that either way.
 *
 * INCREMENTAL CACHING is the actual efficiency win, not chunk size:
 * events in already-scanned ledgers never change, so a second call
 * for the same (contract, topics) only scans from the newest ledger
 * already covered up to the new latestLedger - normally 1 request -
 * instead of repeating the whole backward walk. The cache mirrors
 * into sessionStorage (per browser tab; this app has no backend - see
 * web/app/README.md's "No backend" rule) so a page reload doesn't
 * pay a cold scan again either, keyed by network + contract + topics
 * so a testnet redeploy with new contract addresses can never serve
 * stale events for the old ones.
 *
 * STOPGAP: EventRegistry doesn't yet expose a direct read listing
 * every event it has ever stored (see issue tracking #35 - once that
 * read exists, /events can call it directly instead of scanning the
 * RPC's event log). Everything here stays behind listRegistryEvents()
 * for exactly that reason - swapping the source later is meant to be
 * a one-function change. The getEvents scan stays the real mechanism
 * for an activity feed (e.g. signals_posted), which genuinely has no
 * other direct read.
 */

const server = new rpc.Server(RPC_URL);

export interface EventRecordRaw {
  ledger: number;
  ledgerClosedAt: string;
  topic: unknown[];
  value: unknown;
  id: string;
}

export interface PaginatedEventsResult {
  /** Newest-first, deduped by event id, capped at the query's limit. */
  events: EventRecordRaw[];
  /** The oldest ledger actually scanned before stopping - use this (never getHealth's claimed oldestLedger) for an honest "events in the last N days/hours" label, since it's what was genuinely searched. */
  oldestLedgerScanned: number;
  latestLedger: number;
  latestLedgerCloseTime: number;
  requestCount: number;
  /** True if the hard request cap was hit before the floor or the event limit - the result is still correct (newest-first, no gaps), just possibly short of `limit` even though more history might exist further back. The label this feeds must say so (see components/EventsList's "Loading older events"/"No events in the last N days scanned" copy). */
  stoppedAtRequestCap: boolean;
}

export interface EventQuery {
  contractId: string;
  /** Base64 XDR topic filter segments, e.g. [symbolTopic("sylox"), symbolTopic("event_proposed"), "*"]. */
  topics: string[];
  /** Stop once this many events have been collected, even if the floor hasn't been reached. */
  limit: number;
}

// Measured RPC scan limit per request, not documented, on 2026-10-10
// against soroban-testnet.stellar.org - a single getEvents call's
// cursor advances by roughly this many ledgers regardless of the
// requested range's own size. If this ever drifts, chunks just take
// more or fewer internal pages to cover (fetchChunk below still
// cursor-follows to completion either way) - nothing here assumes
// this number is exact, only that it's a reasonable per-request size.
const CHUNK_SIZE = 10_000;

const FLOOR_MARGIN = 100; // ~8-10 minutes of headroom above the RPC's own retention floor, so real-time drift during the scan never reaches it in practice.
const REQUEST_CAP = 20; // Hard backstop on the whole scan (counts every request, including the one retry and any internal per-chunk paging) - a full 7-day/120,960-ledger scan at CHUNK_SIZE=10,000 is ~13 requests, so this has real headroom above that, while still being a genuine backstop.

function buildFilters(query: EventQuery) {
  return [{ contractIds: [query.contractId], topics: [query.topics] }];
}

/** One request. Returns null (never throws) on the specific "startLedger out of range" error, so the caller can apply its own bounded-retry policy instead of this function retrying on its own. */
async function tryGetEvents(
  query: EventQuery,
  range: { start: number; end: number },
): Promise<Awaited<ReturnType<typeof server.getEvents>> | null> {
  try {
    return await server.getEvents({
      startLedger: range.start,
      endLedger: range.end, // Exclusive - confirmed against the real RPC, see this file's top doc comment.
      filters: buildFilters(query),
      limit: 200,
    });
  } catch (e) {
    const message = e && typeof e === "object" && "message" in e ? String(e.message) : "";
    if (/startLedger must be within the ledger range/i.test(message)) return null;
    throw e;
  }
}

/** One chunk `[start, end)`, paged forward internally if the chunk itself needs more than one request (a CHUNK_SIZE-ledger chunk is sized to the RPC's own measured per-request distance, so this is usually 1-2 requests, not more). */
async function fetchChunk(
  query: EventQuery,
  range: { start: number; end: number },
): Promise<{ events: EventRecordRaw[]; latestLedgerCloseTimeSecs: number; requestCount: number } | null> {
  const events: EventRecordRaw[] = [];
  let cursor: string | undefined;
  let latestLedgerCloseTimeSecs = 0;
  let requestCount = 0;

  for (let page = 0; page < 5; page++) {
    requestCount++;
    let response;
    if (cursor) {
      response = await server.getEvents({ cursor, filters: buildFilters(query), limit: 200 });
    } else {
      response = await tryGetEvents(query, range);
      if (response === null) return null; // Out of range - caller applies the one bounded retry, not this function.
    }

    events.push(...(response.events as unknown as EventRecordRaw[]));
    latestLedgerCloseTimeSecs = Number(response.latestLedgerCloseTime);
    cursor = response.cursor;
    const reached = Number(BigInt(cursor.split("-")[0]) >> BigInt(32));
    if (reached >= range.end - 1) break;
  }

  return { events, latestLedgerCloseTimeSecs, requestCount };
}

/**
 * Scans `[floor, latestLedger]` backward in fixed chunks, newest-first,
 * stopping at `query.limit` events, the floor, or REQUEST_CAP. Calls
 * `onChunk` with everything collected SO FAR (newest-first) after
 * every chunk lands, including the first - the caller can render each
 * batch of rows as it arrives instead of waiting for the whole scan,
 * which can be several chunks (and several seconds) for an older
 * event.
 */
async function scanBackward(
  query: EventQuery,
  latestLedger: number,
  floor: number,
  onChunk?: (eventsSoFar: EventRecordRaw[]) => void,
): Promise<{
  events: EventRecordRaw[];
  oldestLedgerScanned: number;
  latestLedgerCloseTime: number;
  requestCount: number;
  stoppedAtRequestCap: boolean;
}> {
  const ranges = planChunks(latestLedger, floor, CHUNK_SIZE);

  const collected: EventRecordRaw[] = [];
  const seenIds = new Set<string>();
  let latestLedgerCloseTime = 0;
  let requestCount = 0;
  let retryUsed = false;
  let oldestLedgerScanned = latestLedger;
  let stoppedAtRequestCap = false;

  for (let i = 0; i < ranges.length; i++) {
    if (requestCount >= REQUEST_CAP) {
      stoppedAtRequestCap = true;
      break;
    }

    let chunk = await fetchChunk(query, ranges[i]);
    requestCount += chunk === null ? 1 : chunk.requestCount;

    if (chunk === null) {
      // Out-of-range: the one bounded retry (re-fetch health, re-clamp
      // this single chunk). Never retried more than once, and never
      // retried at all if it already happened earlier in this scan.
      if (retryUsed || requestCount >= REQUEST_CAP) break;
      retryUsed = true;
      const freshHealth = await server.getHealth();
      requestCount++; // The getHealth() call itself.
      const freshFloor = freshHealth.oldestLedger + FLOOR_MARGIN;
      const retryStart = Math.max(freshFloor, ranges[i].start);
      if (retryStart >= ranges[i].end) break; // Nothing left of this chunk after re-clamping.
      chunk = await fetchChunk(query, { start: retryStart, end: ranges[i].end });
      requestCount += chunk === null ? 1 : chunk.requestCount;
      if (chunk === null) break; // Failed even after the one retry - stop, return what's already collected.
    }

    if (i === 0) latestLedgerCloseTime = chunk.latestLedgerCloseTimeSecs;
    oldestLedgerScanned = ranges[i].start;

    for (const event of chunk.events) {
      if (seenIds.has(event.id)) continue; // Dedupe across chunk edges.
      seenIds.add(event.id);
      collected.push(event);
    }

    if (onChunk) {
      // A stable newest-first snapshot after every chunk, not just at
      // the end - cheap enough per chunk (at most REQUEST_CAP of
      // them) that sorting on every call is simpler than maintaining
      // a second incrementally-sorted structure.
      const sortedSoFar = [...collected].sort((a, b) => b.ledger - a.ledger);
      onChunk(sortedSoFar);
    }

    if (collected.length >= query.limit) break;
  }

  collected.sort((a, b) => b.ledger - a.ledger);
  return { events: collected, oldestLedgerScanned, latestLedgerCloseTime, requestCount, stoppedAtRequestCap };
}

// ---------------------------------------------------------------------------
// Incremental cache: memory, mirrored into sessionStorage.
// ---------------------------------------------------------------------------

interface CachedState {
  /** Newest-first, deduped. */
  events: EventRecordRaw[];
  /** The oldest ledger this cache's own scan(s) have ever covered down to. */
  oldestLedgerScanned: number;
  /** The newest ledger already covered - a refresh only needs to scan forward from here. */
  latestLedgerCovered: number;
  latestLedgerCloseTime: number;
  stoppedAtRequestCap: boolean;
}

const memoryCache = new Map<string, CachedState>();

function cacheKey(query: EventQuery): string {
  // Network + contract + topics: a testnet redeploy (new contract
  // addresses) can never accidentally serve a stale cache entry for
  // an address that no longer means the same thing.
  return `sylox-events:${testnetDeployment.network}:${query.contractId}:${query.topics.join(",")}`;
}

function readSessionStorage(key: string): CachedState | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as CachedState;
  } catch {
    return null; // Falls back to memory-only, per this file's "wrap every read/write in try/catch" rule.
  }
}

function writeSessionStorage(key: string, state: CachedState): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(key, JSON.stringify(state));
  } catch {
    // Falls back to memory-only - a full/unavailable sessionStorage is never a reason to fail the actual fetch.
  }
}

function loadCached(key: string): CachedState | null {
  const inMemory = memoryCache.get(key);
  if (inMemory) return inMemory;
  const fromSession = readSessionStorage(key);
  if (fromSession) memoryCache.set(key, fromSession);
  return fromSession;
}

function saveCached(key: string, state: CachedState): void {
  memoryCache.set(key, state);
  writeSessionStorage(key, state);
}

export interface FetchEventsOptions {
  /** Called after every chunk lands during a cold (or partially cold) scan, with the events found SO FAR (newest-first) - lets the UI show the newest events after the first request instead of waiting for the whole scan. Never called for a fully-cached, already-warm result. */
  onProgress?: (eventsSoFar: EventRecordRaw[]) => void;
}

/**
 * Cached, incrementally-extended, backward-chunked getEvents scan.
 * The STOPGAP this whole file exists for: see this file's top doc
 * comment's "STOPGAP" paragraph - call this through listRegistryEvents()
 * (events-list-data.ts) for the Events screen specifically, not
 * directly, so that file is the one place to change once a direct
 * contract read replaces this scan.
 */
export async function fetchEventsPaginated(
  query: EventQuery,
  options: FetchEventsOptions = {},
): Promise<PaginatedEventsResult> {
  const key = cacheKey(query);
  const cached = loadCached(key);

  const health = await server.getHealth();
  const floor = health.oldestLedger + FLOOR_MARGIN;

  if (cached && cached.latestLedgerCovered >= health.latestLedger) {
    // Already warm and fully up to date - nothing to scan, but the
    // floor itself can still have moved forward since this was
    // cached even when latestLedger hasn't, so a stale event must
    // still be filtered out here too, not just on the incremental
    // path below.
    const stillFresh = cached.events.filter((e) => e.ledger >= floor);
    return {
      events: stillFresh.slice(0, query.limit),
      oldestLedgerScanned: Math.max(cached.oldestLedgerScanned, floor),
      latestLedger: health.latestLedger,
      latestLedgerCloseTime: cached.latestLedgerCloseTime,
      requestCount: 1, // The getHealth() call above.
      stoppedAtRequestCap: cached.stoppedAtRequestCap,
    };
  }

  let requestCount = 1; // The getHealth() call above.
  let events: EventRecordRaw[];
  let oldestLedgerScanned: number;
  let latestLedgerCloseTime: number;
  let stoppedAtRequestCap: boolean;

  if (cached && cached.latestLedgerCovered >= floor) {
    // Warm, but behind the current tip - only scan the new slice,
    // normally 1 request, then merge with what's already cached.
    const incrementalFloor = cached.latestLedgerCovered + 1;
    const incremental = await scanBackward(query, health.latestLedger, incrementalFloor, options.onProgress);
    requestCount += incremental.requestCount;

    if (incremental.stoppedAtRequestCap && incremental.oldestLedgerScanned > incrementalFloor) {
      // The new slice itself didn't make it all the way back down to
      // incrementalFloor before hitting the request cap - the gap
      // between where it stopped (oldestLedgerScanned) and
      // incrementalFloor was never actually scanned. Recording
      // latestLedgerCovered as health.latestLedger below would claim
      // that untouched gap as covered on the next call, so this
      // replaces the cache with only what THIS scan really saw rather
      // than merging it onto the old (now unverifiable) cached
      // events - the old events's own coverage claim can no longer be
      // trusted once a gap like this exists above them.
      events = incremental.events;
      oldestLedgerScanned = incremental.oldestLedgerScanned;
      latestLedgerCloseTime = incremental.latestLedgerCloseTime;
      stoppedAtRequestCap = true;
    } else {
      const seen = new Set(incremental.events.map((e) => e.id));
      const merged = [
        ...incremental.events,
        ...cached.events.filter((e) => !seen.has(e.id) && e.ledger >= floor), // Drop anything that's since aged below the moving floor.
      ];
      merged.sort((a, b) => b.ledger - a.ledger);

      events = merged;
      oldestLedgerScanned = Math.min(cached.oldestLedgerScanned, incremental.oldestLedgerScanned);
      latestLedgerCloseTime = incremental.latestLedgerCloseTime || cached.latestLedgerCloseTime;
      stoppedAtRequestCap = incremental.stoppedAtRequestCap || cached.stoppedAtRequestCap;
    }
  } else {
    // No usable cache (none at all, or its coverage has entirely aged
    // out below the floor) - a full cold scan.
    const cold = await scanBackward(query, health.latestLedger, floor, options.onProgress);
    requestCount += cold.requestCount;

    events = cold.events;
    oldestLedgerScanned = cold.oldestLedgerScanned;
    latestLedgerCloseTime = cold.latestLedgerCloseTime;
    stoppedAtRequestCap = cold.stoppedAtRequestCap;
  }

  saveCached(key, {
    events,
    oldestLedgerScanned,
    latestLedgerCovered: health.latestLedger,
    latestLedgerCloseTime,
    stoppedAtRequestCap,
  });

  return {
    events: events.slice(0, query.limit),
    oldestLedgerScanned,
    latestLedger: health.latestLedger,
    latestLedgerCloseTime,
    requestCount,
    stoppedAtRequestCap,
  };
}
