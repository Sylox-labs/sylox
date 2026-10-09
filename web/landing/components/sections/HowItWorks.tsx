"use client";

import { useRef } from "react";
import Image from "next/image";
import { howItWorks } from "@/content";
import { useScrollReveal } from "@/lib/motion/useScrollReveal";
import { Eyebrow } from "@sylox/ui/components";

// One wireframe render per part, each a loose visual metaphor rather than
// a literal diagram: an eye for the Oracle's continuous watching, a wax
// seal mid-impact for the Registry's verdict, interlocking chain links
// under tension for the Markets' locked collateral. Alternating left/right
// per row (ProofBridge's feature-grid reference) instead of a uniform
// card grid, so each part reads as its own full-bleed moment.
const PANELS = [
  { src: "/brand/how-it-works-oracle.webp", alt: "Wireframe render of an eye, representing continuous risk monitoring" },
  { src: "/brand/how-it-works-registry.webp", alt: "Wireframe render of a wax seal stamp mid-impact, representing a declared credit event" },
  { src: "/brand/how-it-works-markets.webp", alt: "Wireframe render of interlocking chain links under tension, representing locked collateral" },
];

export function HowItWorks() {
  const containerRef = useRef<HTMLDivElement>(null);
  useScrollReveal(containerRef);

  return (
    <section
      id="how-it-works"
      data-theme="light"
      className="bg-silo-oatmeal"
    >
      <div ref={containerRef} className="px-6 pb-16 pt-24 md:px-16 md:pb-24 md:pt-32">
        <Eyebrow tone="graphite" data-reveal>
          {howItWorks.eyebrow}
        </Eyebrow>
        <h2 data-reveal className="mt-4 max-w-3xl font-display text-4xl leading-[0.95] tracking-tight text-slate-black md:text-6xl">
          {howItWorks.heading}
        </h2>
      </div>

      {/* Each row stays dark regardless of the section's own (now light)
          theme — the text half is pinned to bg-slate-black explicitly
          rather than inheriting it, and the image half is already a
          near-black render baked into the file, so every pixel in this
          block reads dark exactly as designed either way. */}
      <div className="border-t border-cement-grey/20" data-theme="dark">
        {howItWorks.cards.map((card, i) => {
          const panel = PANELS[i];
          const imageFirst = i % 2 === 1;
          return (
            <div
              key={card.title}
              className="grid border-b border-cement-grey/20 md:grid-cols-2"
            >
              <div
                data-reveal
                className={`flex flex-col justify-center bg-slate-black px-6 py-16 md:px-16 md:py-24 ${imageFirst ? "md:order-2" : ""}`}
              >
                <span className="font-mono text-xs text-cement-grey">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3 className="mt-3 font-display text-4xl leading-[0.95] text-silo-oatmeal md:text-5xl">
                  {card.title}
                </h3>
                <p className="mt-6 max-w-md text-base leading-relaxed text-cyber-tin md:text-lg">
                  {card.body}
                </p>
              </div>

              <div
                data-reveal
                className={`relative min-h-[50vh] md:min-h-[32rem] ${imageFirst ? "md:order-1" : ""}`}
              >
                <Image
                  src={panel.src}
                  alt={panel.alt}
                  fill
                  sizes="(min-width: 768px) 50vw, 100vw"
                  className="object-cover"
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
