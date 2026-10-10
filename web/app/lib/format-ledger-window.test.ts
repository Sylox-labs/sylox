import { describe, expect, it } from "vitest";
import { describeScannedWindow } from "./format-ledger-window";

describe("describeScannedWindow", () => {
  it("describes a sub-hour window", () => {
    expect(describeScannedWindow(1000, 999)).toBe("the last hour"); // 1 ledger * 5s.
  });

  it("describes an hours-scale window", () => {
    const ledgers = Math.round((5 * 3600) / 5); // 5 hours.
    expect(describeScannedWindow(100_000, 100_000 - ledgers)).toBe("the last 5 hours");
  });

  it("uses singular for exactly 1 hour", () => {
    const ledgers = Math.round(3600 / 5);
    expect(describeScannedWindow(100_000, 100_000 - ledgers)).toBe("the last 1 hour");
  });

  it("describes a days-scale window with one decimal", () => {
    const ledgers = Math.round((7 * 86400) / 5); // 7 days.
    expect(describeScannedWindow(5_000_000, 5_000_000 - ledgers)).toBe("the last 7 days");
  });

  it("uses singular for exactly 1 day", () => {
    const ledgers = Math.round(86400 / 5);
    expect(describeScannedWindow(100_000, 100_000 - ledgers)).toBe("the last 1 day");
  });

  it("rounds a partial-day window to one decimal", () => {
    const ledgers = Math.round((2.3 * 86400) / 5);
    expect(describeScannedWindow(100_000, 100_000 - ledgers)).toBe("the last 2.3 days");
  });

  it("never goes negative for a zero or inverted range", () => {
    expect(describeScannedWindow(100, 100)).toBe("the last hour");
    expect(describeScannedWindow(100, 200)).toBe("the last hour"); // Clamped, not negative.
  });
});
