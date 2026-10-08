import type { ReactNode } from "react";

interface HeroLayoutProps {
  /** The sticky canvas/visual layer, positioned behind the scrolling panels. */
  canvas: ReactNode;
  /** The four scrolling copy panels, each >= 100vh. */
  panels: ReactNode;
  /** Scroll runway height. ~400vh desktop per brief §7.2, shorter on mobile. */
  runwayHeightClass?: string;
}

/**
 * Shared structural shell for a hero direction: a sticky full-height canvas
 * layer with scrollable copy panels layered on top via a negative-margin
 * runway (the mechanism documented in stellar-websiteguide.md §7.1 — a
 * generic sticky+negative-margin CSS technique, not literal code from it).
 */
export function HeroLayout({
  canvas,
  panels,
  runwayHeightClass = "min-h-[400vh]",
}: HeroLayoutProps) {
  return (
    <section
      data-theme="dark"
      className="relative isolate bg-slate-black"
      aria-label="Sylox: how the risk score works, from peg to payout"
    >
      <div className="sticky top-0 h-screen w-full" aria-hidden="true">
        {canvas}
      </div>
      <div className={`relative z-10 -mt-[100vh] ${runwayHeightClass}`}>
        {panels}
      </div>
    </section>
  );
}
