"use client";

import { useEffect, useRef, useState } from "react";
import { scoreScale } from "@/content";
import { RISK_BANDS, type RiskBandName } from "@/lib/risk-bands";

const SAMPLE_SCORES: Record<RiskBandName, number | "EVENT"> = {
  normal: 12,
  watch: 34,
  warning: 61,
  distress: 88,
  event: "EVENT",
};

// Shared desktop height for the sticky score card AND every row — kept
// as one literal (Tailwind can't interpolate a JS value into a class
// string, so both usages below must match this by hand) so the card and
// whichever row sits level with it are always the same size, instead of
// one card spanning several rows' worth of height. If you change one
// `md:h-[18rem]` below, change the other to match.
const SCORE_ROW_HEIGHT_CLASS = "md:h-[18rem]";

/**
 * Sticky score on the left, band rows scrolling past on the right. As
 * each row crosses the trigger line, the sticky score counts to that
 * band's sample value and recolors. Proofbridge's sticky-sidebar pattern
 * (plain `position: sticky`, no scroll-progress JS for the sticky part
 * itself) plus a GSAP ScrollTrigger per row to drive the count-up.
 */
export function ScoreScale() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeBand, setActiveBand] = useState<RiskBandName>("normal");
  const [displayScore, setDisplayScore] = useState(0);
  const displayScoreRef = useRef(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    const rows = Array.from(
      container.querySelectorAll<HTMLElement>("[data-score-row]"),
    );

    if (prefersReducedMotion) return;

    const triggers: import("gsap/ScrollTrigger").ScrollTrigger[] = [];

    (async () => {
      const [{ default: gsap }, { ScrollTrigger }] = await Promise.all([
        import("gsap"),
        import("gsap/ScrollTrigger"),
      ]);
      gsap.registerPlugin(ScrollTrigger);

      rows.forEach((row) => {
        const band = row.dataset.scoreRow as RiskBandName;
        const trigger = ScrollTrigger.create({
          trigger: row,
          start: "top 60%",
          end: "bottom 40%",
          onEnter: () => animateTo(band),
          onEnterBack: () => animateTo(band),
        });
        triggers.push(trigger);
      });

      function animateTo(band: RiskBandName) {
        setActiveBand(band);
        const target = SAMPLE_SCORES[band];
        if (target === "EVENT") return;
        const counter = { value: displayScoreRef.current };
        gsap.to(counter, {
          value: target,
          duration: 0.8,
          ease: "power2.out",
          onUpdate: () => {
            displayScoreRef.current = counter.value;
            setDisplayScore(Math.round(counter.value));
          },
        });
      }
    })();

    return () => triggers.forEach((t) => t.kill());
  }, []);

  const band = RISK_BANDS.find((b) => b.name === activeBand)!;
  const isEvent = activeBand === "event";

  return (
    <section
      ref={containerRef}
      data-theme="dark"
      className="bg-slate-black px-6 py-24 md:px-16 md:py-32"
    >
      <div className="mx-auto max-w-5xl">
        <p className="font-mono text-xs uppercase tracking-[0.15em] text-cyber-tin md:text-sm">
          {scoreScale.eyebrow}
        </p>
        <h2 className="mt-4 font-display text-3xl leading-[0.95] tracking-tight text-silo-oatmeal md:text-5xl">
          {scoreScale.heading}
        </h2>
      </div>

      <div className="mx-auto mt-16 grid max-w-5xl gap-12 md:grid-cols-[1fr_1.4fr] md:gap-20">
        {/* Sticky at every breakpoint, not just md+: on mobile this is
            the whole point of the section (a live score reacting as you
            scroll the rows below), so it can't be allowed to scroll away
            with the heading. On desktop: a fixed rem height (not vh, and
            not "fit its own content") that matches each row's own height
            exactly — see SCORE_CARD_HEIGHT below, shared by both — so the
            card and whichever row is level with it always read as the
            same size, instead of one card spanning several rows' worth
            of height. Tinted with the ACTIVE band's own color so the
            panel visibly heats up through the sequence. */}
        <div
          className={`sticky top-[72px] z-10 -mx-6 flex flex-col justify-center bg-slate-black/95 px-6 py-4 backdrop-blur transition-colors duration-500 md:top-32 md:z-auto md:mx-0 md:w-fit md:justify-start md:rounded-sm md:px-8 md:py-8 md:backdrop-blur-none ${SCORE_ROW_HEIGHT_CLASS}`}
          style={{
            backgroundColor: `color-mix(in srgb, ${band.colorHex} 18%, var(--color-slate-black))`,
          }}
        >
          <div className="flex items-baseline gap-3 md:block">
            <div
              className="font-mono text-5xl font-bold leading-none transition-colors duration-500 md:text-[6vw]"
              style={{ color: band.colorHex }}
              aria-hidden="true"
            >
              {isEvent ? "EVENT" : String(displayScore).padStart(2, "0")}
            </div>
            <p className="font-mono text-sm uppercase tracking-wide text-cyber-tin md:mt-3">
              {band.label}
            </p>
          </div>
          <p className="sr-only" role="status" aria-live="polite">
            Current illustrative score: {isEvent ? "Event declared" : displayScore}, band {band.label}
          </p>
          <p className="mt-2 font-mono text-[10px] uppercase tracking-wide text-cyber-tin/70 md:mt-4 md:text-xs">
            {scoreScale.sampleLabel}
          </p>
        </div>

        <div className="divide-y divide-cement-grey/30 border-y border-cement-grey/30">
          {scoreScale.rows.map((row) => {
            const rowBand = RISK_BANDS.find((b) => b.name === row.band)!;
            return (
              <div
                key={row.band}
                data-score-row={row.band}
                className={`flex min-h-[22vh] flex-col justify-center gap-3 py-6 md:py-0 ${SCORE_ROW_HEIGHT_CLASS}`}
              >
                <div className="flex items-center gap-3">
                  <span
                    className="h-3 w-3 shrink-0 rounded-full border border-silo-oatmeal/20"
                    style={{ backgroundColor: rowBand.colorHex }}
                    aria-hidden="true"
                  />
                  <span className="font-mono text-sm uppercase tracking-wide text-silo-oatmeal">
                    {rowBand.label}
                  </span>
                  <span className="font-mono text-xs text-cyber-tin">{row.range}</span>
                </div>
                <p className="max-w-md text-base leading-relaxed text-cyber-tin md:text-lg">
                  {row.copy}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
