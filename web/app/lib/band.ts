import { RISK_BANDS, type RiskBand, type RiskBandName } from "@sylox/ui/risk-bands";
import type { Band } from "./contracts/risk-oracle";

const CONTRACT_TAG_TO_BAND_NAME: Record<Band["tag"], RiskBandName> = {
  Normal: "normal",
  Watch: "watch",
  Warning: "warning",
  Distress: "distress",
  Event: "event",
};

/**
 * Maps the contract's own Band enum (RiskOracle.band()/score().band) to
 * the shared design system's band definition (label + color token),
 * so the app reads the band the contract actually computed rather than
 * ever re-deriving it from a raw score client-side.
 */
export function riskBandFor(band: Band): RiskBand {
  const name = CONTRACT_TAG_TO_BAND_NAME[band.tag];
  const match = RISK_BANDS.find((candidate) => candidate.name === name);
  if (!match) {
    throw new Error(`No shared RiskBand definition for contract band "${band.tag}"`);
  }
  return match;
}
