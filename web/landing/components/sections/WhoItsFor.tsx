"use client";

import { useRef } from "react";
import Image from "next/image";
import { ArrowRight } from "lucide-react";
import { whoItsFor } from "@/content";
import { useScrollReveal } from "@/lib/motion/useScrollReveal";
import { Eyebrow } from "@sylox/ui/components";

// One wireframe render per audience, same register as HowItWorks: a hand
// for Holders (weighing whether to buy or sell cover), a wallet for
// Wallets (the object their own users hold), a balance scale for Lenders
// (adjusting collateral is a weighing decision), an anchor for Anchors
// (the product's own namesake). Keyed by `word` so content.ts stays the
// single source of truth for copy.
const CARD_IMAGE: Record<string, string> = {
  HOLDERS: "/brand/who-holders.webp",
  WALLETS: "/brand/who-wallets.webp",
  LENDERS: "/brand/who-lenders.webp",
  ANCHORS: "/brand/who-anchors.webp",
};

/**
 * Asymmetric bento grid instead of a uniform row list: "Holders" (the
 * widest audience, and the one who both buys and sells) takes the large
 * cell; the other three share equal smaller cells. Breaks the "stacked
 * rows" shape every other section was using.
 */
export function WhoItsFor() {
  const containerRef = useRef<HTMLDivElement>(null);
  useScrollReveal(containerRef);

  const [wallets, lenders, anchors, holders] = whoItsFor.rows;

  return (
    <section
      id="who-its-for"
      data-theme="dark"
      className="bg-slate-black px-6 py-24 md:px-16 md:py-32"
    >
      <div ref={containerRef} className="mx-auto max-w-5xl">
        <Eyebrow data-reveal>{whoItsFor.eyebrow}</Eyebrow>
        <h2 data-reveal className="mt-4 max-w-2xl font-display text-4xl leading-[0.95] tracking-tight text-silo-oatmeal md:text-6xl">
          {whoItsFor.heading}
        </h2>

        <div className="mt-16 grid gap-4 md:grid-cols-3 md:grid-rows-2">
          <BentoCell row={holders} className="md:col-span-2 md:row-span-2" large />
          <BentoCell row={wallets} />
          <BentoCell row={lenders} />
          <BentoCell row={anchors} className="md:col-span-2" />
        </div>
      </div>
    </section>
  );
}

function BentoCell({
  row,
  className = "",
  large = false,
}: {
  row: (typeof whoItsFor.rows)[number];
  className?: string;
  large?: boolean;
}) {
  return (
    <div
      data-reveal
      className={`group relative isolate flex min-h-[20rem] flex-col justify-between gap-6 overflow-hidden rounded-sm border border-cement-grey/30 p-8 transition-colors hover:border-risk-crimson/50 md:min-h-0 md:p-10 ${className}`}
    >
      <Image
        src={CARD_IMAGE[row.word]}
        alt=""
        fill
        sizes={large ? "(min-width: 768px) 66vw, 100vw" : "(min-width: 768px) 33vw, 100vw"}
        className="object-cover transition-transform duration-500 group-hover:scale-105"
      />
      <div
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,_rgba(11,12,14,0.55)_0%,_rgba(11,12,14,0.75)_60%,_rgba(11,12,14,0.92)_100%)]"
        aria-hidden="true"
      />

      <div className="relative">
        <p className="font-mono text-xs uppercase tracking-wide text-cyber-tin">
          {row.who}
        </p>
        <h3
          className={`mt-3 font-display leading-[0.92] tracking-tight text-silo-oatmeal transition-colors group-hover:text-risk-crimson-tint ${
            large ? "text-6xl md:text-8xl" : "text-4xl md:text-5xl"
          }`}
        >
          {row.word}
        </h3>
      </div>
      <div className="relative flex items-end justify-between gap-4">
        <p className={`text-cyber-tin ${large ? "max-w-sm text-base md:text-lg" : "max-w-xs text-sm"}`}>
          {row.body}
        </p>
        <ArrowRight
          className="h-5 w-5 shrink-0 text-silo-oatmeal opacity-0 transition-all duration-200 group-hover:translate-x-1 group-hover:opacity-100"
          aria-hidden="true"
        />
      </div>
    </div>
  );
}
