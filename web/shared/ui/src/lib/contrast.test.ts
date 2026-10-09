import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  WCAG_AA_LARGE_TEXT,
  WCAG_AA_NORMAL_TEXT,
} from "./contrast";
import { RISK_BANDS } from "./risk-bands";

describe("contrastRatio", () => {
  it("returns 21:1 for pure black on pure white", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
  });

  it("returns 1:1 for identical colors", () => {
    expect(contrastRatio("#8a9099", "#8a9099")).toBeCloseTo(1, 5);
  });

  it("is symmetric regardless of argument order", () => {
    const a = contrastRatio("#0b0c0e", "#f1efe9");
    const b = contrastRatio("#f1efe9", "#0b0c0e");
    expect(a).toBeCloseTo(b, 10);
  });
});

describe("brand token contrast pairs (brief §9.2 WCAG 2.2 AA)", () => {
  const slateBlack = "#0B0C0E";
  const siloOatmeal = "#F1EFE9";

  it("Silo Oatmeal text on Slate Black clears AA normal text", () => {
    expect(contrastRatio(siloOatmeal, slateBlack)).toBeGreaterThanOrEqual(
      WCAG_AA_NORMAL_TEXT,
    );
  });

  it("Risk Crimson on Slate Black clears AA normal text (brief §4.2: ~5.5:1)", () => {
    const crimson = RISK_BANDS.find((b) => b.name === "distress")!.colorHex;
    expect(contrastRatio(crimson, slateBlack)).toBeGreaterThanOrEqual(
      WCAG_AA_NORMAL_TEXT,
    );
  });

  it("every risk band's color clears at least AA large-text contrast against Slate Black", () => {
    for (const band of RISK_BANDS) {
      const ratio = contrastRatio(band.colorHex, slateBlack);
      expect(ratio, `${band.label} (${band.colorHex})`).toBeGreaterThanOrEqual(
        WCAG_AA_LARGE_TEXT,
      );
    }
  });
});
