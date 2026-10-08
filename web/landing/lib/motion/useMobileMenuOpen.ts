"use client";

import { useEffect, useState } from "react";

const EVENT_NAME = "sylox:mobile-menu-toggle";

/**
 * Tiny cross-component signal so the hero's WebGL canvas can unmount
 * while the mobile nav menu is open. Needed because the menu and the
 * hero are DOM siblings (Header and SimpleHero don't share a parent
 * that could hold this as normal lifted state), and because a WebGL
 * canvas can paint above a CSS z-index/isolation stacking context on
 * some browsers — the only fully reliable fix is to stop rendering it,
 * not just cover it.
 */
export function setMobileMenuOpen(isOpen: boolean) {
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: isOpen }));
}

export function useMobileMenuOpen(): boolean {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const handler = (event: Event) => {
      setIsOpen((event as CustomEvent<boolean>).detail);
    };
    window.addEventListener(EVENT_NAME, handler);
    return () => window.removeEventListener(EVENT_NAME, handler);
  }, []);

  return isOpen;
}
