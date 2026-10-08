"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

interface UseInViewportOptions {
  rootMargin?: string;
  /** Also false while the document tab is hidden, even if intersecting. */
  pauseOnHiddenTab?: boolean;
}

/**
 * Reports whether an element is in (or near) the viewport, and optionally
 * whether the tab itself is visible. Canvases and GSAP timelines use this
 * to stop their render loop off-screen or in a backgrounded tab, per the
 * brief's non-negotiable performance guards (§9.1).
 */
export function useInViewport<T extends Element>(
  options: UseInViewportOptions = {},
): { ref: RefObject<T | null>; isActive: boolean } {
  const { rootMargin = "150px", pauseOnHiddenTab = true } = options;
  const ref = useRef<T | null>(null);
  const [isIntersecting, setIsIntersecting] = useState(false);
  const [isTabVisible, setIsTabVisible] = useState(true);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      ([entry]) => setIsIntersecting(entry.isIntersecting),
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [rootMargin]);

  useEffect(() => {
    if (!pauseOnHiddenTab) return;

    const handleVisibilityChange = () => {
      setIsTabVisible(document.visibilityState === "visible");
    };
    handleVisibilityChange();

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [pauseOnHiddenTab]);

  return { ref, isActive: isIntersecting && isTabVisible };
}
