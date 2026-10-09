"use client";

import { useEffect, useRef, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { problem } from "@/content";
import { useInViewport } from "@/lib/motion/useInViewport";
import { useScrollReveal } from "@/lib/motion/useScrollReveal";

/**
 * Full-bleed two-column row, no max-w-* on the outer grid (same pattern as
 * How It Works' row block) so it spans edge to edge instead of sitting
 * centered with gutters. Left: eyebrow, heading, two-paragraph body (same
 * copy as before — the giant scroll-scrubbed word reveal is gone, it
 * doesn't fit a half-width column). Right: the real Sylox demo video,
 * autoplaying muted while scrolled into view and pausing out of view
 * (useInViewport, same primitive canvases/timelines use elsewhere on this
 * page for the same reason) with a manual mute toggle. Stays on the
 * section's existing light theme — flipping it dark here would put two
 * dark sections back to back with the hero right above it.
 */
export function ProblemStatement() {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { ref: videoWrapRef, isActive } = useInViewport<HTMLDivElement>();
  const [isMuted, setIsMuted] = useState(true);

  useScrollReveal(containerRef);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isActive) {
      video.play().catch(() => {
        // Autoplay can be rejected (e.g. low-power mode); the mute button
        // still lets a visitor start playback by hand.
      });
    } else {
      video.pause();
    }
  }, [isActive]);

  return (
    <section
      data-theme="light"
      className="bg-silo-oatmeal"
    >
      {/* Full-bleed, no max-w-* wrapper — same pattern as How It Works'
          row block, so this spans edge to edge instead of sitting
          centered with oatmeal gutters on both sides. */}
      <div ref={containerRef} className="grid md:grid-cols-2 md:items-stretch">
        <div data-reveal className="flex flex-col justify-center px-6 py-16 md:px-16 md:py-24">
          <p className="font-mono text-xs uppercase tracking-[0.15em] text-anchor-graphite md:text-sm">
            {problem.eyebrow}
          </p>
          <h2 className="mt-4 max-w-xl font-display text-4xl leading-[0.95] tracking-tight text-slate-black md:text-5xl">
            {problem.heading}
          </h2>
          <div className="mt-8 flex max-w-xl flex-col gap-6">
            <p className="text-base leading-relaxed text-anchor-graphite md:text-lg">
              {problem.bodyLeft}
            </p>
            <p className="text-base leading-relaxed text-anchor-graphite md:text-lg">
              {problem.bodyRight}
            </p>
          </div>
        </div>

        <div
          ref={videoWrapRef}
          data-reveal
          className="relative min-h-[50vh] overflow-hidden bg-slate-black md:min-h-0"
        >
          <video
            ref={videoRef}
            // object-position left: the source clip's on-screen text is
            // left-anchored (not centered), so an even object-cover crop
            // (this box is narrower relative to height than the video's
            // native ~1.98:1) eats into the left edge of the text while
            // leaving dead space on the right. Biasing the crop left
            // keeps the text intact and crops the excess from the right
            // instead.
            className="absolute inset-0 h-full w-full object-cover object-left"
            src="/brand/sylox-demo.mp4"
            muted={isMuted}
            loop
            playsInline
            aria-label="Sylox product demo"
          />
          <button
            type="button"
            onClick={() => setIsMuted((muted) => !muted)}
            aria-label={isMuted ? "Unmute video" : "Mute video"}
            className="absolute bottom-5 right-5 z-10 inline-flex h-10 w-10 items-center justify-center rounded-full bg-slate-black/70 text-silo-oatmeal backdrop-blur transition-colors hover:bg-slate-black/90"
          >
            {isMuted ? (
              <VolumeX className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Volume2 className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
    </section>
  );
}
