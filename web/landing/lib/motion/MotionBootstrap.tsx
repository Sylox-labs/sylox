"use client";

import { useEffect } from "react";

/**
 * Mounts once at the root layout. Registers GSAP's ScrollTrigger plugin and
 * starts Lenis smooth scroll, both deferred until after first paint so the
 * hero <h1> — not a library import — is what Lighthouse measures as LCP
 * (brief §9.1). OGL defers separately, per-canvas, since each hero/object
 * canvas only needs to pay that cost once it actually mounts.
 *
 * Renders nothing; it only has side effects.
 */
export function MotionBootstrap() {
  useEffect(() => {
    let lenis: import("lenis").default | undefined;
    let rafId: number;

    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    (async () => {
      const [{ default: gsap }, { ScrollTrigger }, { default: Lenis }] =
        await Promise.all([
          import("gsap"),
          import("gsap/ScrollTrigger"),
          import("lenis"),
        ]);

      gsap.registerPlugin(ScrollTrigger);

      if (prefersReducedMotion) {
        // No smooth-scroll hijacking under reduced motion: native scroll.
        return;
      }

      lenis = new Lenis({ autoRaf: false });
      lenis.on("scroll", ScrollTrigger.update);

      const raf = (time: number) => {
        lenis?.raf(time);
        rafId = requestAnimationFrame(raf);
      };
      rafId = requestAnimationFrame(raf);
    })();

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      lenis?.destroy();
    };
  }, []);

  return null;
}
