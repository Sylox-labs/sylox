import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement matchMedia - same stub as web/landing's and
// web/app's vitest.setup.ts, for any component that reads
// prefers-reduced-motion directly off window.matchMedia.
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
