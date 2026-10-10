import { test, expect, type Page, type Locator } from "@playwright/test";

// Chromium only: screenshot pixels aren't comparable across rendering
// engines regardless of app code, so a cross-engine run would just be
// noise. The a11y and heading checks in accessibility.spec.ts already
// cover mobile-safari.
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "visual regression baselines are Chromium-only",
);

async function freeze(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  // The hero's looping background video has no reduced-motion handling,
  // so every capture otherwise lands on a different frame. Pause it (and
  // seek to a fixed time) so repeated captures are pixel-stable.
  await page.evaluate(() => {
    const video = document.querySelector("video");
    if (video) {
      video.pause();
      video.currentTime = 0;
    }
  });
  await page.waitForTimeout(500);
}

// The hero's looping background video isn't fully frame-stable even
// paused and seeked to t=0 (same-build-against-itself runs still show
// ~1% pixel noise confined to this element, likely sub-frame seek
// rounding). Masked out here because it's a pre-existing rendering-noise
// source, not something this PR's design-system extraction could affect
// (verified: this noise reproduces identically on main with zero code
// changes). The heading/copy that sits on top of it is unaffected and
// stays covered by the zero-diff check everywhere else on the page.
function heroVideoMask(page: Page): Locator[] {
  return [page.locator("video")];
}

test("desktop matches baseline", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await freeze(page);
  await expect(page).toHaveScreenshot("desktop-full.png", {
    fullPage: true,
    maxDiffPixelRatio: 0,
    mask: heroVideoMask(page),
  });
});

test("phone matches baseline", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await freeze(page);
  await expect(page).toHaveScreenshot("phone-full.png", {
    fullPage: true,
    maxDiffPixelRatio: 0,
    mask: heroVideoMask(page),
  });
});

// This page has no prefers-color-scheme handling — its light/dark sections
// are driven entirely by a per-section data-theme attribute, not an OS
// preference, so the full-page captures above already exercise both
// themes. These two isolate one dark section on its own (Who It's For:
// dark theme, no looping video, no scroll-triggered count-up, so it's
// stable without the freeze() helper's extra steps) as a focused
// regression target for dark-theme-specific styling.
test("dark section (desktop) matches baseline", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#who-its-for");
  await page.evaluate(() => document.fonts.ready);
  const section = page.locator("#who-its-for");
  await section.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await expect(section).toHaveScreenshot("dark-section-desktop.png", {
    maxDiffPixelRatio: 0,
  });
});

test("dark section (phone) matches baseline", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#who-its-for");
  await page.evaluate(() => document.fonts.ready);
  const section = page.locator("#who-its-for");
  await section.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await expect(section).toHaveScreenshot("dark-section-phone.png", {
    maxDiffPixelRatio: 0,
  });
});
