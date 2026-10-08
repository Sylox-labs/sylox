"use client";

import { useRef } from "react";
import { HeroLayout } from "@/components/hero/HeroLayout";
import { HeroPanel } from "@/components/hero/HeroPanel";
import { HeroCanvasSwitch } from "@/components/hero/HeroCanvasSwitch";
import { useHeroPanelProgress } from "@/components/hero/useHeroPanelProgress";
import { LedgerGridCanvas } from "@/components/hero/LedgerGridCanvas";
import { LedgerGridStaticFallback } from "@/components/hero/LedgerGridStaticFallback";
import { hero } from "@/content";

/**
 * "Ledger Grid" hero direction. Four `HeroPanel`s over a sticky canvas that
 * never leaves its row/column lattice — see the 3-sentence rationale and
 * state-by-state behavior documented at the top of `LedgerGridCanvas.tsx`.
 */
export default function LedgerGridPage() {
  const sectionRef = useRef<HTMLDivElement>(null);
  useHeroPanelProgress(sectionRef);

  return (
    <div ref={sectionRef}>
      <HeroLayout
        canvas={
          <HeroCanvasSwitch
            motion={<LedgerGridCanvas />}
            staticFallback={<LedgerGridStaticFallback />}
          />
        }
        panels={
          <>
            {hero.panels.map((panel, index) => (
              <HeroPanel
                key={panel.heading}
                eyebrow={panel.eyebrow}
                heading={panel.heading}
                body={panel.body}
                ctas={panel.ctas}
                isFirstPanel={index === 0}
                panelIndex={index}
              />
            ))}
          </>
        }
      />
    </div>
  );
}
