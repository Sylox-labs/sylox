"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useReducedMotion } from "@/lib/motion/useReducedMotion";
import { useMobileMenuOpen } from "@/lib/motion/useMobileMenuOpen";

const Antigravity = dynamic(() => import("@/components/Antigravity"), {
  ssr: false,
});

/**
 * Defers the Three.js canvas until after first paint, same discipline as
 * the rest of the page's motion layer (brief §9.1: the hero <h1>, never a
 * canvas, is the LCP element). Renders nothing under
 * prefers-reduced-motion — the field is decorative, ambient background
 * motion, exactly what that preference opts out of.
 */
export function AntigravityField() {
  const [isReady, setIsReady] = useState(false);
  const prefersReducedMotion = useReducedMotion();
  // WebGL canvases can paint above a CSS z-index/isolation stacking
  // context on some browsers (seen with the mobile nav overlay) — fully
  // unmounting the canvas while the menu is open is the reliable fix,
  // not a CSS-only one.
  const isMobileMenuOpen = useMobileMenuOpen();

  useEffect(() => {
    const id = requestAnimationFrame(() => setIsReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  if (!isReady || prefersReducedMotion || isMobileMenuOpen) return null;

  return (
    <Antigravity
      count={2100}
      magnetRadius={6}
      ringRadius={4}
      waveSpeed={0.4}
      waveAmplitude={1}
      particleSize={0.5}
      lerpSpeed={0.06}
      color="#FF3A30"
      autoAnimate
      particleVariance={1}
      rotationSpeed={0}
      depthFactor={1.5}
      pulseSpeed={5.1}
      particleShape="sphere"
      fieldStrength={5.8}
    />
  );
}
