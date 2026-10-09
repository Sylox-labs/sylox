import type { HTMLAttributes } from "react";

export interface EyebrowProps extends HTMLAttributes<HTMLParagraphElement> {
  /**
   * Matches the section's own theme by hand (no `data-theme` lookup here):
   * `tint` for the muted `cyber-tin` used on dark sections, `graphite` for
   * `anchor-graphite` on light sections.
   */
  tone?: "tint" | "graphite";
}

const TONE_CLASS: Record<NonNullable<EyebrowProps["tone"]>, string> = {
  tint: "text-cyber-tin",
  graphite: "text-anchor-graphite",
};

/**
 * The small Space Mono label that opens every section (brief: eyebrow +
 * heading pattern repeated across Hero, Problem, How It Works, Score
 * Scale, Status, Who It's For, FAQ). One component so every section's
 * label stays byte-identical instead of nine hand-copied class strings.
 * Spreads remaining props (e.g. `data-reveal`) straight onto the `<p>` so
 * it still participates in each section's scroll-reveal wiring.
 */
export function Eyebrow({ tone = "tint", className = "", ...props }: EyebrowProps) {
  return (
    <p
      className={`font-mono text-xs uppercase tracking-[0.15em] md:text-sm ${TONE_CLASS[tone]} ${className}`}
      {...props}
    />
  );
}
