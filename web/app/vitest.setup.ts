import "@testing-library/jest-dom/vitest";

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
