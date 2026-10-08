"use client";

import { useEffect, type RefObject } from "react";

/**
 * Fades + slides up every direct [data-reveal] child of the given
 * container as it scrolls into view, staggered by DOM order. Real GSAP
 * ScrollTrigger on plain DOM elements (opacity/transform only) — the
 * bugs in the earlier WebGL hero were in canvas/shader code, a
 * completely different surface from this.
 */
export function useScrollReveal(containerRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    const targets = Array.from(
      container.querySelectorAll<HTMLElement>("[data-reveal]"),
    );
    if (targets.length === 0) return;

    if (prefersReducedMotion) {
      targets.forEach((el) => {
        el.style.opacity = "1";
        el.style.transform = "none";
      });
      return;
    }

    const triggers: import("gsap/ScrollTrigger").ScrollTrigger[] = [];

    (async () => {
      const [{ default: gsap }, { ScrollTrigger }] = await Promise.all([
        import("gsap"),
        import("gsap/ScrollTrigger"),
      ]);
      gsap.registerPlugin(ScrollTrigger);

      targets.forEach((el, i) => {
        gsap.set(el, { opacity: 0, y: 28 });
        const trigger = ScrollTrigger.create({
          trigger: el,
          start: "top 85%",
          once: true,
          onEnter: () =>
            gsap.to(el, {
              opacity: 1,
              y: 0,
              duration: 0.7,
              delay: (i % 4) * 0.08,
              ease: "power2.out",
            }),
        });
        triggers.push(trigger);
      });
    })();

    return () => {
      triggers.forEach((t) => t.kill());
    };
  }, [containerRef]);
}
