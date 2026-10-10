import { describe, expect, it } from "vitest";
import {
  fetchEffectiveRing,
  fetchPegHistory,
  fetchConfirmed,
  fetchCoverGate,
  fetchLive,
  fetchScoringStart,
  PEG_RATIO_SCALE,
} from "./asset-data";
import type { RingSlot, SlotState, SignalSet } from "./contracts/risk-oracle";
import type { CoverGate } from "./contracts/event-registry";

const RING_SLOTS = 240;
const EPOCH_SECS = 3600;

const EMPTY_ENDPOINT = { tag: "Unknown", values: undefined } as const;

function emptySlot(): RingSlot {
  return {
    epoch: BigInt(0),
    state: { tag: "Empty", values: undefined },
    pending_until: BigInt(0),
    peg_ratio: BigInt(0),
    liquidity_2pct: BigInt(0),
    redemption_net: BigInt(0),
    supply: BigInt(0),
    supply_change_bps: 0,
    clawback_amount: BigInt(0),
    auth_revocations: 0,
    endpoint: EMPTY_ENDPOINT,
    provisional_sub_coverage: undefined,
  };
}

function finalSlot(epoch: bigint, pegRatio: number): RingSlot {
  return {
    ...emptySlot(),
    epoch,
    state: { tag: "Final", values: undefined },
    pending_until: BigInt(0),
    peg_ratio: BigInt(Math.round(pegRatio * PEG_RATIO_SCALE)),
  };
}

function pendingSlot(epoch: bigint, pegRatio: number, pendingUntil: bigint): RingSlot {
  return {
    ...emptySlot(),
    epoch,
    state: { tag: "Pending", values: undefined },
    pending_until: pendingUntil,
    peg_ratio: BigInt(Math.round(pegRatio * PEG_RATIO_SCALE)),
  };
}

/**
 * A fake oracle exposing just the two methods fetchEffectiveRing calls,
 * built from a window of real slots keyed by epoch (a Map, so a sparse
 * "partly filled ring" - the exact case the engineer asked be covered -
 * is just the epochs that are present).
 */
function fakeOracle(opts: {
  ringSlots: RingSlot[]; // oldest-first, length RING_SLOTS - what `ring()` returns.
  effectiveByEpoch: Map<string, SlotState["tag"]>; // what `effective_window` would report, keyed by epoch.toString().
  firstEpoch?: bigint; // what `first_epoch()` would report; undefined = never posted (matches "treat every hour as tracked").
  firstEpochThrows?: boolean; // simulates first_epoch() failing, to exercise fetchPegHistory's fallback.
}) {
  return {
    ring: async () => ({ result: opts.ringSlots }),
    effective_window: async ({
      start_epoch,
      count,
    }: {
      asset: string;
      start_epoch: bigint;
      count: number;
    }) => {
      const result = [];
      for (let i = 0; i < count; i++) {
        const epoch = start_epoch + BigInt(i);
        const tag = opts.effectiveByEpoch.get(epoch.toString());
        result.push(tag ? ({ tag, values: undefined } as SlotState) : undefined);
      }
      return { result };
    },
    first_epoch: async () => {
      if (opts.firstEpochThrows) throw new Error("first_epoch unreachable");
      return { result: opts.firstEpoch };
    },
    score: async () => ({
      result: {
        isErr: () => false,
        unwrap: () => ({
          epoch: BigInt(1),
          score: 5,
          band: { tag: "Normal", values: undefined },
          formula_version: 1,
          stale: false,
        }),
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("fetchEffectiveRing", () => {
  it("derives the time axis from the newest epoch, not from an Empty slot's stored epoch (0)", async () => {
    // A ring with only the last 3 slots ever written - the other 237 are
    // the storage default, epoch: 0. Using slot.epoch directly for the
    // axis would put 237 points in 1970; this must not happen.
    const newestEpoch = BigInt(500_000);
    const ringSlots: RingSlot[] = [];
    for (let i = 0; i < RING_SLOTS; i++) {
      ringSlots.push(emptySlot());
    }
    // Place three real slots at the newest 3 positions (array is oldest-first).
    ringSlots[RING_SLOTS - 3] = finalSlot(newestEpoch - BigInt(2), 1.0);
    ringSlots[RING_SLOTS - 2] = finalSlot(newestEpoch - BigInt(1), 0.999);
    ringSlots[RING_SLOTS - 1] = finalSlot(newestEpoch, 1.0001);

    const effectiveByEpoch = new Map<string, SlotState["tag"]>([
      [(newestEpoch - BigInt(2)).toString(), "Final"],
      [(newestEpoch - BigInt(1)).toString(), "Final"],
      [newestEpoch.toString(), "Final"],
    ]);

    const oracle = fakeOracle({ ringSlots, effectiveByEpoch });
    const ring = await fetchEffectiveRing(oracle, "ASSET");

    expect(ring).toHaveLength(RING_SLOTS);

    // No slot's derived epoch is 0 or anywhere near 1970 - every position,
    // written or not, gets a real epoch on the continuous axis.
    for (const slot of ring) {
      expect(slot.epoch).toBeGreaterThan(BigInt(0));
    }

    // The axis is contiguous and ends at the newest epoch.
    expect(ring[ring.length - 1].epoch).toBe(newestEpoch);
    expect(ring[0].epoch).toBe(newestEpoch - BigInt(RING_SLOTS - 1));
    for (let i = 1; i < ring.length; i++) {
      expect(ring[i].epoch).toBe(ring[i - 1].epoch + BigInt(1));
    }

    // The 3 genuinely-written slots land at their correct derived epoch.
    expect(ring[ring.length - 1].peg_ratio).toBe(ringSlots[RING_SLOTS - 1].peg_ratio);
    expect(ring[ring.length - 1].effectiveState).toBe("Final");
  });

  it("promotes a Pending slot past its own pending_until to effectively Final", async () => {
    const newestEpoch = BigInt(500_000);
    const ringSlots: RingSlot[] = Array.from({ length: RING_SLOTS }, () => emptySlot());
    // Stored as Pending, but effective_window (the contract's own
    // now >= pending_until rule) says it's actually Final now.
    ringSlots[RING_SLOTS - 1] = pendingSlot(newestEpoch, 0.998, BigInt(1000));

    const effectiveByEpoch = new Map<string, SlotState["tag"]>([[newestEpoch.toString(), "Final"]]);
    const oracle = fakeOracle({ ringSlots, effectiveByEpoch });

    const history = await fetchPegHistory(oracle, "ASSET");
    const newestPoint = history[history.length - 1];

    // The raw stored state was Pending, but the effective state (what the
    // chart and the legend use) is Final - this is the whole point of
    // using effective_window instead of state.tag raw.
    expect(newestPoint.state).toBe("Final");
    expect(newestPoint.pegRatio).toBeCloseTo(0.998, 5);
  });

  it("keeps a genuinely Pending slot (now < pending_until) as a gap, never a fake 0", async () => {
    const newestEpoch = BigInt(500_000);
    const ringSlots: RingSlot[] = Array.from({ length: RING_SLOTS }, () => emptySlot());
    ringSlots[RING_SLOTS - 1] = pendingSlot(newestEpoch, 0.998, BigInt(9_999_999_999));

    const effectiveByEpoch = new Map<string, SlotState["tag"]>([[newestEpoch.toString(), "Pending"]]);
    const oracle = fakeOracle({ ringSlots, effectiveByEpoch });

    const history = await fetchPegHistory(oracle, "ASSET");
    const newestPoint = history[history.length - 1];

    expect(newestPoint.state).toBe("Pending");
    expect(newestPoint.pegRatio).toBeNull();
  });

  it("assigns every Empty slot a real, contiguous epoch even in a sparsely filled ring", async () => {
    // A partly filled ring: only epoch (newest - 50) and newest are real;
    // everything else in between and before is still Empty.
    const newestEpoch = BigInt(10_000);
    const ringSlots: RingSlot[] = Array.from({ length: RING_SLOTS }, () => emptySlot());
    ringSlots[RING_SLOTS - 51] = finalSlot(newestEpoch - BigInt(50), 1.0);
    ringSlots[RING_SLOTS - 1] = finalSlot(newestEpoch, 1.0);

    const effectiveByEpoch = new Map<string, SlotState["tag"]>([
      [(newestEpoch - BigInt(50)).toString(), "Final"],
      [newestEpoch.toString(), "Final"],
    ]);
    const oracle = fakeOracle({ ringSlots, effectiveByEpoch });

    const ring = await fetchEffectiveRing(oracle, "ASSET");

    const emptySlots = ring.filter((s) => s.effectiveState === "Empty");
    expect(emptySlots.length).toBe(RING_SLOTS - 2);
    for (const slot of emptySlots) {
      expect(slot.epoch).toBeGreaterThan(BigInt(0));
    }
    // Still one epoch apart from its neighbors - no gap or jump in the axis.
    expect(ring[0].epoch).toBe(newestEpoch - BigInt(RING_SLOTS - 1));
  });

  it("anchors on the newest non-Empty slot's own index, not the array's last index", async () => {
    // ADR-005: an overturned slot returns to Empty for reposting. If the
    // most recently posted hour was overturned, the array's LAST slot
    // (index 239) is Empty even though a real, newer-than-everything-else
    // slot still sits a few positions earlier (index 237). Anchoring on
    // "the last index" instead of that slot's actual index would derive
    // every epoch in the ring off by (239 - 237) = 2 hours.
    const trueNewestEpoch = BigInt(500_000);
    const anchorIndex = RING_SLOTS - 3; // 237 - two positions before the end.
    const ringSlots: RingSlot[] = Array.from({ length: RING_SLOTS }, () => emptySlot());
    ringSlots[anchorIndex] = finalSlot(trueNewestEpoch, 0.9995);
    // The last two slots (238, 239) are genuinely Empty - the overturned
    // hour and the one after it, neither reposted yet.

    const effectiveByEpoch = new Map<string, SlotState["tag"]>([
      [trueNewestEpoch.toString(), "Final"],
    ]);
    const oracle = fakeOracle({ ringSlots, effectiveByEpoch });

    const ring = await fetchEffectiveRing(oracle, "ASSET");

    // The real slot keeps its own true epoch, from its own array index -
    // not from being misread as sitting at the last index.
    expect(ring[anchorIndex].epoch).toBe(trueNewestEpoch);
    expect(ring[anchorIndex].effectiveState).toBe("Final");

    // The axis still ends 2 epochs after the anchor (the array's last
    // index is 2 positions past the anchor), and is still contiguous
    // and real (never 0) all the way through - including past the
    // anchor, where nothing was ever written.
    expect(ring[ring.length - 1].epoch).toBe(trueNewestEpoch + BigInt(2));
    for (let i = 1; i < ring.length; i++) {
      expect(ring[i].epoch).toBe(ring[i - 1].epoch + BigInt(1));
    }

    // The two trailing Empty slots are genuinely gaps, not 0 or a fake value.
    const history = await fetchPegHistory(oracle, "ASSET");
    expect(history[history.length - 1].pegRatio).toBeNull();
    expect(history[history.length - 2].pegRatio).toBeNull();
    expect(history[anchorIndex].pegRatio).toBeCloseTo(0.9995, 5);
  });
});

describe("fetchPegHistory timestamps", () => {
  it("uses the derived epoch (not the raw stored one) for the timestamp axis", async () => {
    const newestEpoch = BigInt(500_000);
    const ringSlots: RingSlot[] = Array.from({ length: RING_SLOTS }, () => emptySlot());
    ringSlots[RING_SLOTS - 1] = finalSlot(newestEpoch, 1.0);
    const effectiveByEpoch = new Map<string, SlotState["tag"]>([[newestEpoch.toString(), "Final"]]);
    const oracle = fakeOracle({ ringSlots, effectiveByEpoch });

    const history = await fetchPegHistory(oracle, "ASSET");
    const newestPoint = history[history.length - 1];

    expect(newestPoint.timestamp).toBe(Number(newestEpoch) * EPOCH_SECS);
    // Not anywhere near 1970 (timestamp 0).
    expect(history[0].timestamp).toBeGreaterThan(0);
  });
});

describe("fetchPegHistory tracked", () => {
  it("marks every hour tracked when first_epoch is unknown (never posted)", async () => {
    const ringSlots: RingSlot[] = Array.from({ length: RING_SLOTS }, () => emptySlot());
    const oracle = fakeOracle({ ringSlots, effectiveByEpoch: new Map(), firstEpoch: undefined });

    const history = await fetchPegHistory(oracle, "ASSET");

    expect(history.every((p) => p.tracked)).toBe(true);
  });

  it("marks hours before first_epoch untracked, not missing", async () => {
    const newestEpoch = BigInt(500_000);
    const firstEpoch = newestEpoch - BigInt(49); // Asset is only 50 hours old - window is 240.
    const ringSlots: RingSlot[] = Array.from({ length: RING_SLOTS }, () => emptySlot());
    ringSlots[RING_SLOTS - 1] = finalSlot(newestEpoch, 1.0);
    ringSlots[RING_SLOTS - 50] = finalSlot(firstEpoch, 1.0); // The asset's very first posted hour.

    const effectiveByEpoch = new Map<string, SlotState["tag"]>([
      [newestEpoch.toString(), "Final"],
      [firstEpoch.toString(), "Final"],
    ]);
    const oracle = fakeOracle({ ringSlots, effectiveByEpoch, firstEpoch });

    const history = await fetchPegHistory(oracle, "ASSET");

    // Everything before the asset's first epoch is untracked...
    const untracked = history.filter((p) => !p.tracked);
    expect(untracked).toHaveLength(RING_SLOTS - 50);
    for (const point of untracked) {
      expect(point.epoch).toBeLessThan(firstEpoch);
    }
    // ...and everything from first_epoch onward is tracked, including
    // real gaps that happen to exist in that tracked range.
    const tracked = history.filter((p) => p.tracked);
    expect(tracked).toHaveLength(50);
    expect(tracked.every((p) => p.epoch >= firstEpoch)).toBe(true);
  });

  it("falls back to treating every hour as tracked if first_epoch() fails", async () => {
    const newestEpoch = BigInt(500_000);
    const ringSlots: RingSlot[] = Array.from({ length: RING_SLOTS }, () => emptySlot());
    ringSlots[RING_SLOTS - 1] = finalSlot(newestEpoch, 1.0);
    const effectiveByEpoch = new Map<string, SlotState["tag"]>([[newestEpoch.toString(), "Final"]]);
    const oracle = fakeOracle({ ringSlots, effectiveByEpoch, firstEpochThrows: true });

    const history = await fetchPegHistory(oracle, "ASSET");

    expect(history.every((p) => p.tracked)).toBe(true);
  });
});

describe("fetchConfirmed", () => {
  it("uses the newest EFFECTIVELY final slot's peg value, not latest()", async () => {
    const newestEpoch = BigInt(500_000);
    const ringSlots: RingSlot[] = Array.from({ length: RING_SLOTS }, () => emptySlot());
    // Second-newest is Final; newest is still genuinely Pending.
    ringSlots[RING_SLOTS - 2] = finalSlot(newestEpoch - BigInt(1), 0.9995);
    ringSlots[RING_SLOTS - 1] = pendingSlot(newestEpoch, 0.97, BigInt(9_999_999_999));

    const effectiveByEpoch = new Map<string, SlotState["tag"]>([
      [(newestEpoch - BigInt(1)).toString(), "Final"],
      [newestEpoch.toString(), "Pending"],
    ]);
    const oracle = fakeOracle({ ringSlots, effectiveByEpoch });

    const { confirmed, latestPending } = await fetchConfirmed(oracle, "ASSET");

    expect(confirmed).not.toBeNull();
    expect(confirmed!.epoch).toBe(newestEpoch - BigInt(1));
    expect(confirmed!.pegRatio).toBeCloseTo(0.9995, 5);

    expect(latestPending).not.toBeNull();
    expect(latestPending!.epoch).toBe(newestEpoch);
    expect(latestPending!.pegRatio).toBeCloseTo(0.97, 5);
    expect(latestPending!.pendingUntil).toBe(BigInt(9_999_999_999));
  });

  it("promotes a Pending-past-deadline newest slot into Confirmed, with no separate latestPending", async () => {
    const newestEpoch = BigInt(500_000);
    const ringSlots: RingSlot[] = Array.from({ length: RING_SLOTS }, () => emptySlot());
    ringSlots[RING_SLOTS - 1] = pendingSlot(newestEpoch, 0.998, BigInt(1000));

    const effectiveByEpoch = new Map<string, SlotState["tag"]>([[newestEpoch.toString(), "Final"]]);
    const oracle = fakeOracle({ ringSlots, effectiveByEpoch });

    const { confirmed, latestPending } = await fetchConfirmed(oracle, "ASSET");

    expect(confirmed).not.toBeNull();
    expect(confirmed!.epoch).toBe(newestEpoch);
    expect(latestPending).toBeNull();
  });

  it("returns null for both when the ring has no real slots yet", async () => {
    const ringSlots: RingSlot[] = Array.from({ length: RING_SLOTS }, () => emptySlot());
    const oracle = fakeOracle({ ringSlots, effectiveByEpoch: new Map() });

    const { confirmed, latestPending } = await fetchConfirmed(oracle, "ASSET");

    expect(confirmed).toBeNull();
    expect(latestPending).toBeNull();
  });
});

/**
 * fetchCoverGate's own fake clients: just the 3 reads it makes
 * (check_stale, score, cover_gate) - this mirrors Series.buy_cover's
 * real step 2 (technical-doc.md Section 9.4): stale OR band
 * Distress/Event OR cover_gate not Clear all independently reject.
 */
function fakeCoverGateClients(opts: {
  stale: boolean;
  band: string;
  gate: CoverGate["tag"];
}) {
  const oracle = {
    check_stale: async () => ({ result: { isErr: () => false, unwrap: () => opts.stale } }),
    score: async () => ({
      result: {
        isErr: () => false,
        unwrap: () => ({
          epoch: BigInt(1),
          score: 5,
          band: { tag: opts.band, values: undefined },
          formula_version: 1,
          stale: opts.stale,
        }),
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const registry = {
    cover_gate: async () => ({
      result: { isErr: () => false, unwrap: () => ({ tag: opts.gate, values: undefined }) },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { oracle, registry };
}

describe("fetchCoverGate", () => {
  it("says sales are paused for staleness before ever checking cover_gate", async () => {
    const { oracle, registry } = fakeCoverGateClients({ stale: true, band: "Normal", gate: "Clear" });

    const status = await fetchCoverGate(oracle, registry, "ASSET");

    expect(status.gate).toBe("Stale");
    expect(status.label).toMatch(/not enough price history yet/i);
  });

  it("says sales are paused for a Distress band, even when cover_gate itself is Clear", async () => {
    const { oracle, registry } = fakeCoverGateClients({
      stale: false,
      band: "Distress",
      gate: "Clear",
    });

    const status = await fetchCoverGate(oracle, registry, "ASSET");

    expect(status.gate).toBe("Distressed");
    expect(status.label).toMatch(/the asset is in distress/i);
  });

  it("says sales are paused for an Event band", async () => {
    const { oracle, registry } = fakeCoverGateClients({ stale: false, band: "Event", gate: "Clear" });

    const status = await fetchCoverGate(oracle, registry, "ASSET");

    expect(status.gate).toBe("Distressed");
  });

  it("falls through to cover_gate's own reason once stale and band both pass", async () => {
    const { oracle, registry } = fakeCoverGateClients({
      stale: false,
      band: "Watch",
      gate: "RecentDepeg",
    });

    const status = await fetchCoverGate(oracle, registry, "ASSET");

    expect(status.gate).toBe("RecentDepeg");
    expect(status.label).toMatch(/below the threshold/i);
  });

  it("only says sales can go through when stale, band, and cover_gate all pass", async () => {
    const { oracle, registry } = fakeCoverGateClients({ stale: false, band: "Normal", gate: "Clear" });

    const status = await fetchCoverGate(oracle, registry, "ASSET");

    expect(status.gate).toBe("Clear");
    expect(status.label).toBe("Cover can be sold.");
  });

  it("treats Normal and Watch bands as not-distressed", async () => {
    const { oracle, registry } = fakeCoverGateClients({ stale: false, band: "Watch", gate: "Clear" });

    const status = await fetchCoverGate(oracle, registry, "ASSET");

    expect(status.gate).toBe("Clear");
  });
});

function fakeSignalSet(overrides: Partial<SignalSet> = {}): SignalSet {
  return {
    endpoint: { tag: "Unknown", values: undefined },
    epoch: BigInt(0),
    inputs_hash: Buffer.alloc(32),
    issuer_actions: { auth_revocations: 0, clawback_amount: BigInt(0), clawbacks: 0, flag_changes: 0 },
    liquidity_2pct: BigInt(0),
    peg_ratio: BigInt(0),
    peg_ratio_p10: BigInt(0),
    posted_at: BigInt(0),
    poster: "GPOSTER",
    redemption_net: BigInt(0),
    supply: BigInt(0),
    supply_change_bps: 0,
    ...overrides,
  };
}

describe("fetchLive", () => {
  it("returns 'none' when live() resolves to None", async () => {
    const oracle = { live: async () => ({ result: undefined }) } as unknown as Parameters<
      typeof fetchLive
    >[0];

    const value = await fetchLive(oracle, "ASSET");

    expect(value).toEqual({ status: "none" });
  });

  it("maps a Some result to peg ratio, sub-epoch, slot state, and posted_at", async () => {
    const oracle = {
      live: async () => ({
        result: [
          { hour: BigInt(497_606), sub: 7 },
          fakeSignalSet({ peg_ratio: BigInt(9_995_000), posted_at: BigInt(1_000_000) }),
          { tag: "Pending", values: undefined },
        ] as const,
      }),
    } as unknown as Parameters<typeof fetchLive>[0];

    const value = await fetchLive(oracle, "ASSET");

    expect(value.status).toBe("value");
    if (value.status !== "value") throw new Error("expected 'value'");
    expect(value.subEpoch).toEqual({ hour: BigInt(497_606), sub: 7 });
    expect(value.pegRatio).toBeCloseTo(0.9995, 5);
    expect(value.slotState).toBe("Pending");
    expect(value.postedAt).toBe(1_000_000);
  });
});

describe("fetchScoringStart", () => {
  it("says 'unknown' when first_epoch() resolves to None", async () => {
    const oracle = { first_epoch: async () => ({ result: undefined }) } as unknown as Parameters<
      typeof fetchScoringStart
    >[0];

    const start = await fetchScoringStart(oracle, "ASSET");

    expect(start).toEqual({ status: "unknown" });
  });

  it("says 'unknown' when first_epoch() throws", async () => {
    const oracle = {
      first_epoch: async () => {
        throw new Error("unreachable");
      },
    } as unknown as Parameters<typeof fetchScoringStart>[0];

    const start = await fetchScoringStart(oracle, "ASSET");

    expect(start).toEqual({ status: "unknown" });
  });

  it("computes (first_epoch + 168h) + SIGNAL_DISPUTE_SECS for the real USDC test case (first_epoch=497606 -> 2026-10-14T16:00:00Z)", async () => {
    const oracle = {
      first_epoch: async () => ({ result: BigInt(497_606) }),
    } as unknown as Parameters<typeof fetchScoringStart>[0];

    const start = await fetchScoringStart(oracle, "ASSET");

    expect(start.status).toBe("pending");
    if (start.status !== "pending") throw new Error("expected 'pending'");
    expect(new Date(start.earliestUnixSecs * 1000).toISOString()).toBe("2026-10-14T16:00:00.000Z");
  });
});

describe("fetchPegHistory provisionalSubCoverage", () => {
  it("passes through provisional_sub_coverage for a Pending hour on the sub-epoch path", async () => {
    const newestEpoch = BigInt(500_000);
    const ringSlots: RingSlot[] = Array.from({ length: RING_SLOTS }, () => emptySlot());
    ringSlots[RING_SLOTS - 1] = {
      ...pendingSlot(newestEpoch, 0.998, BigInt(9_999_999_999)),
      provisional_sub_coverage: 5,
    };

    const effectiveByEpoch = new Map<string, SlotState["tag"]>([[newestEpoch.toString(), "Pending"]]);
    const oracle = fakeOracle({ ringSlots, effectiveByEpoch });

    const history = await fetchPegHistory(oracle, "ASSET");
    const newestPoint = history[history.length - 1];

    expect(newestPoint.state).toBe("Pending");
    expect(newestPoint.provisionalSubCoverage).toBe(5);
  });

  it("leaves provisionalSubCoverage null for a Final hour", async () => {
    const newestEpoch = BigInt(500_000);
    const ringSlots: RingSlot[] = Array.from({ length: RING_SLOTS }, () => emptySlot());
    ringSlots[RING_SLOTS - 1] = finalSlot(newestEpoch, 1.0);

    const effectiveByEpoch = new Map<string, SlotState["tag"]>([[newestEpoch.toString(), "Final"]]);
    const oracle = fakeOracle({ ringSlots, effectiveByEpoch });

    const history = await fetchPegHistory(oracle, "ASSET");
    const newestPoint = history[history.length - 1];

    expect(newestPoint.state).toBe("Final");
    expect(newestPoint.provisionalSubCoverage).toBeNull();
  });
});
