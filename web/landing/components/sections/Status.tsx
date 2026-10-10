"use client";

import { useMemo, useRef } from "react";
import { status } from "@/content";
import { useScrollReveal } from "@/lib/motion/useScrollReveal";
import { Eyebrow } from "@sylox/ui/components";

type ItemState = "done" | "active" | "future";

function stateOf(tag: string): ItemState {
  if (tag === "IN PROGRESS") return "active";
  if (tag === "NEXT" || tag === "BEFORE MAINNET" || tag === "AFTER LEGAL REVIEW") return "future";
  return "done";
}

const MARKER: Record<ItemState, string> = {
  done: "bg-slate-black",
  active: "bg-risk-crimson",
  future: "border border-cement-grey/60",
};

const LABEL: Record<ItemState, string> = {
  done: "text-slate-black",
  active: "text-slate-black",
  future: "text-anchor-graphite/60",
};

const TAG: Record<ItemState, string> = {
  done: "text-anchor-graphite",
  active: "text-risk-crimson",
  future: "text-anchor-graphite/50",
};

/**
 * A build log, not a roadmap graphic: one continuous list of one-line
 * entries (marker + index + label + tag), identical shape at every
 * viewport — no separate mobile treatment, no dots-and-connecting-line
 * timeline, no per-item card. A single giant "done/total" statement on
 * the left is the one hero-scale moment, echoing the big-numeral device
 * used elsewhere on the page (How It Works, the old ghost numerals) but
 * spent once here rather than repeated per item. Light section: with
 * How It Works and Who It's For locked to dark (their wireframe renders
 * assume a near-black ground), Status sits between them as the light
 * section required to keep the whole page's background strictly
 * alternating rather than running three-plus dark sections in a row.
 */
export function Status() {
  const containerRef = useRef<HTMLDivElement>(null);
  useScrollReveal(containerRef);

  const doneCount = useMemo(
    () => status.items.filter((item) => stateOf(item.tag) === "done").length,
    [],
  );

  return (
    <section
      id="status"
      data-theme="light"
      className="bg-silo-oatmeal px-6 py-24 md:px-16 md:py-32"
    >
      <div
        ref={containerRef}
        className="mx-auto grid max-w-5xl gap-12 md:grid-cols-[1fr_1.3fr] md:gap-20"
      >
        <div>
          <Eyebrow tone="graphite" data-reveal>{status.eyebrow}</Eyebrow>
          <h2
            data-reveal
            className="mt-4 font-display text-4xl leading-[0.95] tracking-tight text-slate-black md:text-6xl"
          >
            {status.heading}
          </h2>
          <p data-reveal className="mt-4 max-w-sm text-base leading-relaxed text-anchor-graphite md:text-lg">
            {status.body}
          </p>

          <div data-reveal className="mt-12 md:mt-20">
            <div className="font-display text-7xl leading-none tracking-tight text-slate-black md:text-8xl">
              {doneCount}
              <span className="text-cement-grey">/{status.items.length}</span>
            </div>
            <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.15em] text-anchor-graphite/70 md:text-xs">
              Steps shipped
            </p>
          </div>
        </div>

        <div data-reveal className="divide-y divide-cement-grey/30 border-t border-cement-grey/30 md:mt-2">
          {status.items.map((item, i) => {
            const state = stateOf(item.tag);
            return (
              <div
                key={item.label}
                className="flex items-baseline gap-4 py-5 md:gap-6 md:py-6"
              >
                <span
                  aria-hidden="true"
                  className={`h-2 w-2 shrink-0 translate-y-[-0.1em] rounded-full ${MARKER[state]}`}
                />
                <span className="w-6 shrink-0 font-mono text-xs text-cement-grey">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <p className={`flex-1 text-base leading-snug md:text-lg ${LABEL[state]}`}>
                  {item.label}
                </p>
                <span
                  className={`shrink-0 whitespace-nowrap font-mono text-[10px] uppercase tracking-wide md:text-xs ${TAG[state]}`}
                >
                  {item.tag}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
