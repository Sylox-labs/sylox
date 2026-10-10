import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * web/app and web/landing each commit their own real copy of this mark
 * (not a symlink - breaks on Windows checkouts and some build
 * platforms, see the PR review) and NOT a build-time copy step either
 * (adds a predev/prebuild script both apps would need to remember to
 * run before next dev too, not just a production build). A plain
 * byte-for-byte check here is the actual guard against the two
 * copies silently drifting apart - it fails loudly the moment someone
 * edits one copy (resize, recolor, swap the artwork) and forgets the
 * other, rather than shipping two different logos unnoticed.
 */
describe("sylox-mark.webp", () => {
  it("is byte-identical to web/landing's copy of the same mark", () => {
    const appCopy = readFileSync(path.join(__dirname, "sylox-mark.webp"));
    const landingCopy = readFileSync(
      path.join(__dirname, "../../../landing/public/brand/sylox-mark.webp"),
    );

    const appHash = createHash("sha256").update(appCopy).digest("hex");
    const landingHash = createHash("sha256").update(landingCopy).digest("hex");

    expect(appHash).toBe(landingHash);
  });
});
