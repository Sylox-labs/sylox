"use client";

import { useRef } from "react";
import Image from "next/image";
import { footer, openSource, nav } from "@/content";
import { useScrollReveal } from "@/lib/motion/useScrollReveal";

/**
 * Just the dark footer now — the early-access section (light poster
 * heading + waitlist form) was removed entirely, taking its "Get early
 * access" CTAs with it (see Header.tsx and SimpleHero.tsx).
 */
export function FinalCtaAndFooter() {
  const containerRef = useRef<HTMLDivElement>(null);
  useScrollReveal(containerRef);

  return (
    <>
      <footer ref={containerRef} data-theme="dark" className="bg-slate-black px-6 py-16 md:px-16">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-center gap-3">
            <Image
              src="/brand/sylox-mark.webp"
              alt=""
              width={1315}
              height={1139}
              className="h-12 w-auto"
            />
            <span className="font-display text-3xl font-black uppercase tracking-tight text-silo-oatmeal">
              Sylox
            </span>
          </div>

          <div className="mt-10 grid gap-10 border-b border-cement-grey/30 pb-12 md:grid-cols-4">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.15em] text-cyber-tin">
                {openSource.eyebrow}
              </p>
              <p className="mt-3 text-sm leading-relaxed text-silo-oatmeal">
                {openSource.heading}
              </p>
            </div>
            {openSource.items.map((item) => (
              <div key={item.title}>
                <p className="font-mono text-xs uppercase tracking-wide text-silo-oatmeal">
                  {item.title}
                </p>
                <p className="mt-2 text-sm leading-relaxed text-cyber-tin">
                  {item.body}
                </p>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-6 pt-8 text-sm text-cyber-tin md:flex-row md:items-center md:justify-between">
            <p className="text-xs">{footer.tagline}</p>
            <nav className="flex gap-6" aria-label="Footer">
              <a
                href={nav.github.href}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-silo-oatmeal"
              >
                GitHub
              </a>
              <a href={footer.links.x} className="hover:text-silo-oatmeal">
                X
              </a>
              <a href={footer.links.contact} className="hover:text-silo-oatmeal">
                Contact
              </a>
            </nav>
          </div>
          <div className="mt-6 text-xs text-cyber-tin/70">
            © {new Date().getFullYear()} Sylox. {footer.builtOnStellar}.
          </div>
        </div>
      </footer>
    </>
  );
}
