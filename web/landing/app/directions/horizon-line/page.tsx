"use client";

import { useRef } from "react";
import { HeroLayout } from "@/components/hero/HeroLayout";
import { HeroPanel } from "@/components/hero/HeroPanel";
import { HeroCanvasSwitch } from "@/components/hero/HeroCanvasSwitch";
import { useHeroPanelProgress } from "@/components/hero/useHeroPanelProgress";
import { HorizonLineCanvas } from "@/components/hero/HorizonLineCanvas";
import { HorizonLineStaticFallback } from "@/components/hero/HorizonLineStaticFallback";
import { hero } from "@/content";

/**
 * Route for the "Horizon Line" hero direction. Structural shell only —
 * all state/motion logic lives in HorizonLineCanvas.
 */
export default function HorizonLineDirectionPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  useHeroPanelProgress(containerRef);

  return (
    <main ref={containerRef}>
      <HeroLayout
        canvas={
          <HeroCanvasSwitch
            motion={<HorizonLineCanvas />}
            staticFallback={<HorizonLineStaticFallback />}
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
    </main>
  );
}
