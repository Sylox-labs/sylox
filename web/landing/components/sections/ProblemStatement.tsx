"use client";

import { useEffect, useRef } from "react";
import { problem } from "@/content";

/**
 * The problem statement gets its own full editorial moment: one giant
 * poster-scale line that lights up word by word as you scroll past it,
 * scrubbed to scroll position (not timed) so it feels tied to the page,
 * not just a fade-in. Safe DOM/CSS version of the brief's scrubbed
 * character reveal — animates span opacity via GSAP ScrollTrigger scrub,
 * no canvas.
 */
export function ProblemStatement() {
  const containerRef = useRef<HTMLDivElement>(null);
  const statementRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const statement = statementRef.current;
    if (!statement) return;

    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    const words = Array.from(statement.querySelectorAll<HTMLElement>("[data-word]"));

    if (prefersReducedMotion) {
      words.forEach((w) => (w.style.opacity = "1"));
      return;
    }

    let trigger: import("gsap/ScrollTrigger").ScrollTrigger | undefined;

    (async () => {
      const [{ default: gsap }, { ScrollTrigger }] = await Promise.all([
        import("gsap"),
        import("gsap/ScrollTrigger"),
      ]);
      gsap.registerPlugin(ScrollTrigger);

      gsap.set(words, { opacity: 0.12 });
      trigger = ScrollTrigger.create({
        trigger: statement,
        start: "top 80%",
        end: "bottom 55%",
        scrub: 0.3,
        onUpdate: (self) => {
          const lit = Math.floor(self.progress * words.length);
          words.forEach((w, i) => {
            gsap.to(w, { opacity: i < lit ? 1 : 0.12, duration: 0.15, overwrite: true });
          });
        },
      });
    })();

    return () => trigger?.kill();
  }, []);

  const words = problem.heading.split(" ");

  return (
    <section
      ref={containerRef}
      data-theme="light"
      className="bg-silo-oatmeal px-6 py-32 md:px-16 md:py-48"
    >
      <div className="mx-auto max-w-6xl">
        <p className="font-mono text-xs uppercase tracking-[0.15em] text-anchor-graphite md:text-sm">
          {problem.eyebrow}
        </p>
        <h2
          ref={statementRef}
          className="mt-8 font-display text-[12vw] leading-[0.92] tracking-tight text-slate-black md:text-[6.5vw]"
        >
          {words.map((word, i) => (
            <span key={i} data-word className="inline-block">
              {word}
              {i < words.length - 1 ? " " : ""}
            </span>
          ))}
        </h2>

        <div className="mt-16 grid gap-10 border-t border-cement-grey/40 pt-10 md:grid-cols-2 md:gap-16">
          <p className="text-base leading-relaxed text-anchor-graphite md:text-lg">
            {problem.bodyLeft}
          </p>
          <p className="text-base leading-relaxed text-anchor-graphite md:text-lg">
            {problem.bodyRight}
          </p>
        </div>
      </div>
    </section>
  );
}
