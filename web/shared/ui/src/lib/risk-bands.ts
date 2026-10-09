// Single source of truth for the Sylox risk score bands: ranges, labels,
// and color tokens. Every section that shows a score (hero, score scale,
// feed preview) reads from here so the ramp never drifts between sections.
//
// Ranges per technical-doc.md §6.3. Colors: a traffic-light ramp (muted
// green -> amber -> orange -> crimson) rather than the brief's original
// "intensity ramp, not traffic lights" guidance — overridden deliberately
// per explicit direction, so Normal reads unambiguously "healthy" and
// Event reads unambiguously "failure," the way red/green already does
// everywhere else. Desaturated to stay in step with the brand's muted
// palette rather than a generic saturated status-light look.

export type RiskBandName = "normal" | "watch" | "warning" | "distress" | "event";

export interface RiskBand {
  name: RiskBandName;
  label: string;
  min: number;
  max: number;
  /** CSS color token (var(...)) used for text/fills representing this band. */
  colorVar: string;
  /** Resolved hex, for contrast calculations and non-CSS contexts (canvas). */
  colorHex: string;
}

export const RISK_BANDS: RiskBand[] = [
  {
    name: "normal",
    label: "Normal",
    min: 0,
    max: 24,
    colorVar: "var(--color-risk-normal)",
    colorHex: "#7FB88A",
  },
  {
    name: "watch",
    label: "Watch",
    min: 25,
    max: 49,
    colorVar: "var(--color-risk-watch)",
    colorHex: "#E0B860",
  },
  {
    name: "warning",
    label: "Warning",
    min: 50,
    max: 74,
    colorVar: "var(--color-risk-warning)",
    colorHex: "#E08A4F",
  },
  {
    name: "distress",
    label: "Distress",
    min: 75,
    max: 100,
    colorVar: "var(--color-risk-crimson)",
    colorHex: "#FF3B30",
  },
  {
    name: "event",
    label: "Event",
    min: 101,
    max: 101,
    colorVar: "var(--color-risk-crimson)",
    colorHex: "#FF3B30",
  },
];

/**
 * Resolve the band for a numeric score (0-100). "Event" is not reachable by
 * score alone — it is only ever set explicitly when a credit event has been
 * declared, per technical-doc.md §6.3 ("sticky until governance re-registers
 * a new canonical definition version"). Pass `isEventDeclared` to force it.
 */
export function getBandForScore(
  score: number,
  isEventDeclared = false,
): RiskBand {
  if (isEventDeclared) {
    return RISK_BANDS[RISK_BANDS.length - 1];
  }
  const clamped = Math.max(0, Math.min(100, score));
  const band = RISK_BANDS.find(
    (candidate) => clamped >= candidate.min && clamped <= candidate.max,
  );
  if (!band) {
    throw new Error(`No risk band defined for score ${score}`);
  }
  return band;
}
