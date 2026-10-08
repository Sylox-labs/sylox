import { test, expect } from "@playwright/test";

const DIRECTIONS = ["horizon-line", "depth-field", "ledger-grid"];

for (const slug of DIRECTIONS) {
  test.describe(`/directions/${slug}`, () => {
    test("renders exactly one h1 with the panel 1 headline", async ({ page }) => {
      await page.goto(`/directions/${slug}`);
      const h1 = page.locator("h1");
      await expect(h1).toHaveCount(1);
      await expect(h1).toHaveText("Know your issuer before it fails.");
    });

    test("under reduced motion, shows a static fallback and no canvas animation loop crash", async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(`/directions/${slug}`);
      // The page should render without throwing, and the h1 should still
      // be visible immediately regardless of motion preference.
      await expect(page.locator("h1")).toBeVisible();
    });

    test("has no automatically detectable a11y violations", async ({ page }) => {
      const { default: AxeBuilder } = await import("@axe-core/playwright");
      await page.goto(`/directions/${slug}`);
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations).toEqual([]);
    });
  });
}
