import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    // Package default stays "node" (most of this package is pure
    // functions/tokens, no DOM) - a component test opts into jsdom
    // per-file with a `// @vitest-environment jsdom` docblock instead
    // of paying the jsdom cost for every test here.
    environment: "node",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    exclude: ["**/node_modules/**"],
  },
});
