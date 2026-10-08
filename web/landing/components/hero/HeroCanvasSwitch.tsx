"use client";

import type { ReactNode } from "react";
import { useReducedMotion } from "@/lib/motion/useReducedMotion";

interface HeroCanvasSwitchProps {
  /** The live WebGL/motion canvas. */
  motion: ReactNode;
  /** A static, composed frame per state, crossfaded on scroll (brief §7.2 "Reduced motion"). */
  staticFallback: ReactNode;
}

/**
 * Every hero direction's canvas layer goes through this switch rather than
 * branching inline, so the reduced-motion contract is identical across all
 * three directions and easy to audit in one place.
 */
export function HeroCanvasSwitch({ motion, staticFallback }: HeroCanvasSwitchProps) {
  const prefersReducedMotion = useReducedMotion();
  return <>{prefersReducedMotion ? staticFallback : motion}</>;
}
