import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement matchMedia; several components read
// prefers-reduced-motion directly off window.matchMedia (not via a
// hook that could be mocked per-test), so this needs a global stub.
// Default to "no match" (matches: false) for every query, i.e. the
// same as a real browser with no reduced-motion preference set.
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
