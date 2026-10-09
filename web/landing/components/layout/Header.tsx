"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { ArrowUpRight, Menu, X } from "lucide-react";
import { nav } from "@/content";
import { setMobileMenuOpen } from "@/lib/motion/useMobileMenuOpen";
import { useActiveSection } from "@/lib/motion/useActiveSection";

function Logo() {
  return (
    <Image
      src="/brand/sylox-mark.webp"
      alt="Sylox"
      width={100}
      height={44}
      className="h-[3em] w-[4em]"
      priority
    />
  );
}

export function Header() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const sectionIds = useMemo(
    () => nav.links.map((link) => link.href.replace("#", "")),
    [],
  );
  const activeId = useActiveSection(sectionIds);

  useEffect(() => {
    setMobileMenuOpen(isMenuOpen);
  }, [isMenuOpen]);

  // GSAP must own the panel's transform from the very first frame (via
  // gsap.set, not a React inline style string): mixing a raw CSS
  // `transform` set through React's style prop with later
  // gsap.to({xPercent}) calls leaves GSAP's internal transform cache out
  // of sync with the DOM, so both its "closed" and "open" states resolve
  // to the wrong offset. This runs once on mount, before the open/close
  // effect below ever calls gsap.to on this element.
  useEffect(() => {
    const panel = menuRef.current;
    if (!panel) return;
    let cancelled = false;
    (async () => {
      const { default: gsap } = await import("gsap");
      if (!cancelled) gsap.set(panel, { xPercent: 100 });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Always-mounted panel, animated between off-screen (xPercent: 100) and
  // on-screen (xPercent: 0) — avoids the mount/unmount timing dance a
  // conditionally-rendered panel would need to let its close animation
  // finish before leaving the DOM.
  useEffect(() => {
    const panel = menuRef.current;
    if (!panel) return;

    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    if (prefersReducedMotion) {
      panel.style.transform = "none";
      panel.style.visibility = isMenuOpen ? "visible" : "hidden";
      return;
    }

    let cancelled = false;
    (async () => {
      const { default: gsap } = await import("gsap");
      if (cancelled) return;

      if (isMenuOpen) {
        panel.style.visibility = "visible";
        const items = panel.querySelectorAll<HTMLElement>("[data-menu-item]");
        gsap.set(items, { opacity: 0, x: 24 });
        const tl = gsap.timeline();
        tl.to(panel, { xPercent: 0, duration: 0.4, ease: "power3.out" }).to(
          items,
          {
            opacity: 1,
            x: 0,
            duration: 0.6,
            stagger: 0.06,
            ease: "elastic.out(1, 0.6)",
          },
          "-=0.15",
        );
      } else {
        gsap.to(panel, {
          xPercent: 100,
          duration: 0.35,
          ease: "power2.in",
          onComplete: () => {
            if (!cancelled) panel.style.visibility = "hidden";
          },
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isMenuOpen]);

  useEffect(() => {
    if (!isMenuOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsMenuOpen(false);
        menuButtonRef.current?.focus();
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = menuRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled])',
      );
      if (!focusable || focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    const firstLink = menuRef.current?.querySelector<HTMLElement>("a[href]");
    firstLink?.focus();

    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isMenuOpen]);

  return (
    <>
      <header
        data-theme="dark"
        className="fixed inset-x-0 top-0 z-50 h-[72px] border-b border-cement-grey/20 bg-slate-black/90 backdrop-blur"
      >
        <div className="mx-auto flex h-full max-w-6xl items-center justify-between px-6">
          <a href="#top" aria-label="Sylox home">
            <Logo />
          </a>

          <nav className="hidden items-center gap-6 md:flex" aria-label="Primary">
            {nav.links.map((link) => {
              const isActive = activeId === link.href.replace("#", "");
              return (
                <a
                  key={link.href}
                  href={link.href}
                  aria-current={isActive ? "true" : undefined}
                  className={`group relative font-mono text-xs uppercase tracking-[0.1em] transition-colors hover:text-silo-oatmeal ${
                    isActive ? "text-silo-oatmeal" : "text-cyber-tin"
                  }`}
                >
                  {link.label}
                  <span
                    className={`absolute -bottom-1 left-0 h-px bg-silo-oatmeal transition-all duration-200 group-hover:w-full ${
                      isActive ? "w-full" : "w-0"
                    }`}
                  />
                </a>
              );
            })}
            <a
              href={nav.github.href}
              target="_blank"
              rel="noopener noreferrer"
              className="group relative inline-flex items-center gap-1 font-mono text-xs uppercase tracking-[0.1em] text-cyber-tin transition-colors hover:text-silo-oatmeal"
            >
              {nav.github.label}
              <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
              <span className="absolute -bottom-1 left-0 h-px w-0 bg-silo-oatmeal transition-all duration-200 group-hover:w-full" />
            </a>
          </nav>

          <div className="flex items-center gap-4">
            <button
              ref={menuButtonRef}
              type="button"
              className="inline-flex items-center justify-center md:hidden"
              aria-label={isMenuOpen ? "Close menu" : "Open menu"}
              aria-expanded={isMenuOpen}
              onClick={() => setIsMenuOpen((open) => !open)}
            >
              {isMenuOpen ? (
                <X className="h-6 w-6 text-silo-oatmeal" aria-hidden="true" />
              ) : (
                <Menu className="h-6 w-6 text-silo-oatmeal" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Deliberately a SIBLING of <header>, not nested inside it: the
          header has backdrop-blur, and per the CSS spec, backdrop-filter
          (like filter/transform/perspective) creates a new containing
          block for position:fixed descendants. Nested here, this panel's
          bottom-0 was resolving against the header's own 72px box
          instead of the viewport, collapsing it to a sliver.

          Always mounted (not conditionally rendered) so GSAP can animate
          it off-screen on close before it's hidden — style starts at
          xPercent(100%)/invisible via inline style+CSS so there's no
          flash of an on-screen panel before the first effect run. */}
      <div
        ref={menuRef}
        data-theme="dark"
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        aria-hidden={!isMenuOpen}
        style={{ visibility: "hidden" }}
        className="fixed inset-x-0 top-[72px] bottom-0 z-50 flex flex-col gap-6 bg-slate-black p-8 md:hidden"
      >
        {nav.links.map((link) => (
          <a
            key={link.href}
            href={link.href}
            data-menu-item
            tabIndex={isMenuOpen ? 0 : -1}
            className="font-display text-3xl text-silo-oatmeal"
            onClick={() => setIsMenuOpen(false)}
          >
            {link.label}
          </a>
        ))}
        <a
          href={nav.github.href}
          target="_blank"
          rel="noopener noreferrer"
          data-menu-item
          tabIndex={isMenuOpen ? 0 : -1}
          className="inline-flex items-center gap-2 font-display text-3xl text-silo-oatmeal"
          onClick={() => setIsMenuOpen(false)}
        >
          {nav.github.label}
          <ArrowUpRight className="h-5 w-5" aria-hidden="true" />
        </a>
      </div>
    </>
  );
}
