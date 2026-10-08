"use client";

import { useEffect, type RefObject } from "react";
import { writeProgressVar } from "@/lib/motion/scrollProgressVar";

/**
 * Wires a ScrollTrigger to each [data-hero-panel] after the first, writing
 * its scroll progress to --panel-progress so the CSS entrance rule in
 * globals.css can animate off it. No-ops under reduced motion (panels
 * render at full opacity via the same CSS media guard).
 */
export function useHeroPanelProgress(containerRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (prefersReducedMotion) return;

    let triggers: import("gsap/ScrollTrigger").ScrollTrigger[] = [];

    (async () => {
      // Register the plugin against gsap's own core here rather than
      // assuming MotionBootstrap's independent dynamic import has already
      // done so — registerPlugin is idempotent, but ScrollTrigger.create()
      // throws ("_context is not a function") if called before any
      // registration has run against this module graph's gsap instance.
      const [{ default: gsap }, { ScrollTrigger }] = await Promise.all([
        import("gsap"),
        import("gsap/ScrollTrigger"),
      ]);
      gsap.registerPlugin(ScrollTrigger);

      const panels = Array.from(
        container.querySelectorAll<HTMLElement>("[data-hero-panel]"),
      ).slice(1);

      triggers = panels.map((panel) =>
        ScrollTrigger.create({
          trigger: panel,
          start: "top 90%",
          end: "top 35%",
          scrub: true,
          onUpdate: (self) => writeProgressVar(panel, self, "--panel-progress"),
        }),
      );
    })();

    return () => {
      triggers.forEach((trigger) => trigger.kill());
    };
  }, [containerRef]);
}
