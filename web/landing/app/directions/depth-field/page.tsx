"use client";

import { useRef } from "react";
import { HeroLayout } from "@/components/hero/HeroLayout";
import { HeroPanel } from "@/components/hero/HeroPanel";
import { HeroCanvasSwitch } from "@/components/hero/HeroCanvasSwitch";
import { useHeroPanelProgress } from "@/components/hero/useHeroPanelProgress";
import { DepthFieldCanvas } from "@/components/hero/DepthFieldCanvas";
import { hero } from "@/content";

/**
 * "Depth Field" static fallback for prefers-reduced-motion: a plain CSS
 * composition approximating state 1 ("holding the peg") — sparse Cyber Tin
 * dots with a few Silo Oatmeal flecks over the slate-black field, with a
 * radial falloff standing in for depth. Simplification noted per brief
 * §7.2: a single static frame rather than a per-state crossfade set.
 */
function DepthFieldStaticFallback() {
  const dots = Array.from({ length: 48 }, (_, i) => {
    const left = (i * 37) % 100;
    const top = (i * 53) % 100;
    const isOatmeal = i % 7 === 0;
    const size = 2 + ((i * 5) % 5);
    return { left, top, isOatmeal, size, key: i };
  });

  return (
    <div className="relative h-full w-full overflow-hidden bg-slate-black">
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 50% 45%, rgba(176,181,188,0.12), transparent 65%)",
        }}
      />
      {dots.map((dot) => (
        <span
          key={dot.key}
          className="absolute rounded-full"
          style={{
            left: `${dot.left}%`,
            top: `${dot.top}%`,
            width: dot.size,
            height: dot.size,
            backgroundColor: dot.isOatmeal
              ? "var(--color-silo-oatmeal)"
              : "var(--color-cyber-tin)",
            opacity: dot.isOatmeal ? 0.9 : 0.55,
          }}
        />
      ))}
    </div>
  );
}

export default function DepthFieldPage() {
  const sectionRef = useRef<HTMLDivElement>(null);
  useHeroPanelProgress(sectionRef);

  const panels = hero.panels;

  return (
    <div ref={sectionRef}>
      <HeroLayout
        canvas={
          <HeroCanvasSwitch
            motion={<DepthFieldCanvas />}
            staticFallback={<DepthFieldStaticFallback />}
          />
        }
        panels={
          <>
            <HeroPanel
              isFirstPanel
              panelIndex={0}
              eyebrow={panels[0].eyebrow}
              heading={panels[0].heading}
              body={panels[0].body}
              ctas={panels[0].ctas}
            />
            <HeroPanel
              panelIndex={1}
              eyebrow={panels[1].eyebrow}
              heading={panels[1].heading}
              body={panels[1].body}
            />
            <HeroPanel
              panelIndex={2}
              eyebrow={panels[2].eyebrow}
              heading={panels[2].heading}
              body={panels[2].body}
            />
            <HeroPanel
              panelIndex={3}
              eyebrow={panels[3].eyebrow}
              heading={panels[3].heading}
              body={panels[3].body}
              ctas={panels[3].ctas}
            />
          </>
        }
      />
    </div>
  );
}
