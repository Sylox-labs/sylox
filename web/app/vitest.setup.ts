import { vi } from "vitest";
import "@testing-library/jest-dom/vitest";

// No real Next.js App Router context exists in these component tests,
// so usePathname() (used by components/DashboardShell.tsx to mark the
// active nav item) would otherwise return null and make every page
// test fail just for rendering the shell, not for whatever that test
// actually checks. Defaults to "/" (Explorer); a test that cares about
// a different active route overrides this mock itself.
vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return { ...actual, usePathname: () => "/" };
});

// jsdom doesn't implement matchMedia. Stubbed here for any component
// that reads prefers-reduced-motion directly off window.matchMedia
// (see web/landing/vitest.setup.ts, which added this after a real
// test failure from its absence).
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}
