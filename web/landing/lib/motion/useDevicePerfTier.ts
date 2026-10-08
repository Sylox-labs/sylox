"use client";

import { useEffect, useState } from "react";

export type PerfTier = "mobile" | "tablet" | "desktop";

/**
 * Classifies the current device into a performance tier from viewport
 * width, downgraded one step when `navigator.hardwareConcurrency` suggests
 * a weak CPU. Each particle system (hero WebGL field, Canvas 2D object)
 * maps this tier to its own point-count budget — the tiers are shared,
 * the counts are not, since WebGL points and Canvas 2D sprite blits have
 * very different per-particle costs.
 */
function classifyPerfTier(): PerfTier {
  if (typeof window === "undefined") return "desktop";

  const width = window.innerWidth;
  const cores = navigator.hardwareConcurrency ?? 4;

  let base: PerfTier = "desktop";
  if (width < 768) base = "mobile";
  else if (width < 1024) base = "tablet";

  if (cores < 4 && base === "desktop") return "tablet";
  if (cores < 4 && base === "tablet") return "mobile";
  return base;
}

export function useDevicePerfTier(): PerfTier {
  const [tier, setTier] = useState<PerfTier>(classifyPerfTier);

  useEffect(() => {
    const handleResize = () => setTier(classifyPerfTier());
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return tier;
}

/**
 * WebGL hero point-field budget, derived from an ~8ms/frame update+render
 * target on mid-tier hardware for a 4-state line/scatter/converge/settle
 * story (not Stellar's continuous ribbon-to-globe-to-burst choreography,
 * which justifies far fewer points). Validate with profiling during build.
 */
export const HERO_PARTICLE_COUNTS: Record<PerfTier, number> = {
  mobile: 3000,
  tablet: 10000,
  desktop: 25000,
};

/**
 * Canvas 2D "How it works" object budget. Scaled down from the reference
 * site's 6,000/2,400 since our shapes are simpler (gauge, seal, vault) —
 * not a richer multi-shape scene.
 */
export const OBJECT_PARTICLE_COUNTS: Record<PerfTier, number> = {
  mobile: 1000,
  tablet: 1800,
  desktop: 2800,
};
