import { describe, expect, it } from "vitest";
import { getBandForScore, RISK_BANDS } from "./risk-bands";

describe("getBandForScore", () => {
  it("resolves every exact boundary to the correct band", () => {
    expect(getBandForScore(0).name).toBe("normal");
    expect(getBandForScore(24).name).toBe("normal");
    expect(getBandForScore(25).name).toBe("watch");
    expect(getBandForScore(49).name).toBe("watch");
    expect(getBandForScore(50).name).toBe("warning");
    expect(getBandForScore(74).name).toBe("warning");
    expect(getBandForScore(75).name).toBe("distress");
    expect(getBandForScore(100).name).toBe("distress");
  });

  it("clamps out-of-range scores instead of throwing", () => {
    expect(getBandForScore(-10).name).toBe("normal");
    expect(getBandForScore(150).name).toBe("distress");
  });

  it("forces the Event band when a credit event is declared, regardless of score", () => {
    expect(getBandForScore(5, true).name).toBe("event");
    expect(getBandForScore(100, true).name).toBe("event");
  });

  it("defines a contiguous, non-overlapping range for every reachable band", () => {
    const scoreBands = RISK_BANDS.filter((band) => band.name !== "event");
    const sorted = [...scoreBands].sort((a, b) => a.min - b.min);
    expect(sorted[0].min).toBe(0);
    expect(sorted[sorted.length - 1].max).toBe(100);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].min).toBe(sorted[i - 1].max + 1);
    }
  });
});
