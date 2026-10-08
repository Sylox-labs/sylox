"use client";

import { useRef } from "react";
import { status } from "@/content";
import { useScrollReveal } from "@/lib/motion/useScrollReveal";

// Each status gets a genuinely distinct chip treatment, not a uniform dot:
// solid fills for the two states that have actually happened (done, or
// actively underway), a bordered chip for everything still ahead.
const TAG_CHIP: Record<string, string> = {
  PUBLISHED: "border border-slate-black bg-slate-black text-silo-oatmeal",
  "IN DEVELOPMENT": "border border-risk-crimson bg-risk-crimson text-slate-black",
  NEXT: "border border-anchor-graphite text-anchor-graphite",
  PLANNED: "border border-anchor-graphite text-anchor-graphite",
  "BEFORE MAINNET": "border border-anchor-graphite text-anchor-graphite",
  "AFTER LEGAL REVIEW": "border border-anchor-graphite text-anchor-graphite",
};

// Desktop's timeline dot is small — a plain fill color reads better there
// than the bordered-chip treatment the mobile cards use.
const TAG_DOT: Record<string, string> = {
  PUBLISHED: "bg-slate-black",
  "IN DEVELOPMENT": "bg-risk-crimson",
  NEXT: "bg-cement-grey",
  PLANNED: "bg-cement-grey",
  "BEFORE MAINNET": "bg-cement-grey",
  "AFTER LEGAL REVIEW": "bg-cement-grey",
};

/**
 * On mobile: big stacked index cards, one per milestone, each full width
 * with its own number treated as giant ghost type bleeding off the card
 * edge (same device as How It Works' panels) and the status rendered as
 * a real colored chip, not a small dot — six confident statements in
 * sequence, not a checklist. Desktop keeps the horizontal timeline,
 * which has room to read as a line without needing this per-card weight.
 */
export function Status() {
  const containerRef = useRef<HTMLDivElement>(null);
  useScrollReveal(containerRef);

  return (
    <section
      id="status"
      data-theme="light"
      className="bg-silo-oatmeal px-6 py-24 md:px-16 md:py-32"
    >
      <div ref={containerRef} className="mx-auto max-w-5xl">
        <p data-reveal className="font-mono text-xs uppercase tracking-[0.15em] text-anchor-graphite md:text-sm">
          {status.eyebrow}
        </p>
        <h2
          data-reveal
          className="mt-4 max-w-2xl font-display text-4xl leading-[0.95] tracking-tight text-slate-black md:text-6xl"
        >
          {status.heading}
        </h2>
        <p data-reveal className="mt-4 max-w-md text-base leading-relaxed text-anchor-graphite md:text-lg">
          {status.body}
        </p>

        {/* Mobile: stacked index cards. */}
        <div className="mt-16 flex flex-col gap-4 md:hidden">
          {status.items.map((item, i) => (
            <div
              key={item.label}
              data-reveal
              className="relative overflow-hidden rounded-sm border border-cement-grey/40 bg-silo-oatmeal p-6"
            >
              <span
                aria-hidden="true"
                className="pointer-events-none absolute -right-3 -top-6 select-none font-mono text-8xl font-bold leading-none text-cement-grey/15"
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              <div className="relative">
                <span
                  className={`inline-block rounded-full px-3 py-1 font-mono text-[10px] font-medium uppercase tracking-wide ${
                    TAG_CHIP[item.tag] ?? "border border-anchor-graphite text-anchor-graphite"
                  }`}
                >
                  {item.tag}
                </span>
                <p className="mt-4 max-w-[80%] font-display text-2xl leading-[1.05] text-slate-black">
                  {item.label}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Desktop: horizontal timeline. */}
        <div data-reveal className="mt-20 hidden md:flex">
          {status.items.map((item, i) => (
            <div
              key={item.label}
              className="relative flex flex-1 flex-col gap-4 px-4 first:pl-0 last:pr-0"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`h-2.5 w-2.5 shrink-0 rounded-full ${TAG_DOT[item.tag] ?? "bg-cement-grey"}`}
                  aria-hidden="true"
                />
                <div className="h-px flex-1 bg-cement-grey/50" aria-hidden="true" />
              </div>
              <span className="font-mono text-[10px] uppercase tracking-wide text-anchor-graphite/70">
                {String(i + 1).padStart(2, "0")}
              </span>
              <p className="text-base leading-snug text-slate-black">{item.label}</p>
              <span className="font-mono text-xs uppercase tracking-wide text-anchor-graphite">
                {item.tag}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
