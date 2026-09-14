import { test, expect } from "@playwright/test";
import { readFixtures } from "./fixtures/db";

// Vendor portal login is a passwordless magic link (see src/lib/vendor-auth.ts) —
// normally emailed, with no dev bypass endpoint. e2e/global-setup.ts generates
// a real token directly via Prisma (the same sha256-hashed-token scheme the
// app itself uses) so this test can drive the actual /vendor/verify/[token]
// flow without needing real email delivery.
test("vendor can sign in via magic link and see their dashboard", async ({ page }) => {
  const fixtures = readFixtures();

  await page.goto(`/vendor/verify/${fixtures.vendorVerifyToken}`);
  await page.waitForURL(/\/vendor\/.+\/dashboard/, { timeout: 30000 });

  // See playwright.config.ts's own comment — Neon's compute can take 25-30s
  // to wake from idle on the first query after a while.
  await expect(page.getByRole("heading", { name: fixtures.vendorName })).toBeVisible({ timeout: 30000 });
  // Rendered with a curly apostrophe (Today&rsquo;s) — match loosely rather
  // than depend on the exact glyph.
  await expect(page.getByText(/Today.s sales/i)).toBeVisible();
  await expect(page.getByText(/Today.s transactions/i)).toBeVisible();
});
