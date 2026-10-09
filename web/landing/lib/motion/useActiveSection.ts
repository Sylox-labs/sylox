"use client";

import { useEffect, useState } from "react";

/**
 * Tracks which of the given section ids is currently most visible in the
 * viewport, for the header's active-tab underline. Uses IntersectionObserver
 * rather than a scroll listener — section visibility is exactly what it's
 * built for, no manual scroll-position math or rAF throttling needed.
 *
 * The header is 72px tall and fixed, so the observer's rootMargin pulls the
 * top in by that much (otherwise a section scrolled just under the header
 * would still count as "visible" at its very top edge) and biases toward
 * the upper portion of the remaining viewport, so a section is considered
 * active once it's the one actually sitting behind the nav bar, not just
 * barely peeking into view at the bottom.
 */
export function useActiveSection(ids: string[]): string | null {
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const elements = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);

    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting);
        if (visible.length === 0) return;

        const topmost = visible.reduce((a, b) =>
          a.boundingClientRect.top <= b.boundingClientRect.top ? a : b,
        );
        setActiveId(topmost.target.id);
      },
      {
        rootMargin: "-72px 0px -60% 0px",
        threshold: 0,
      },
    );

    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [ids]);

  return activeId;
}
