import { test, expect } from "@playwright/test";
import { readFixtures } from "./fixtures/db";

// Vendor portal login is a passwordless magic link (see src/lib/vendor-auth.ts) —
// normally emailed, with no dev bypass endpoint. e2e/global-setup.ts generates
// a real token directly via Prisma (the same sha256-hashed-token scheme the
// app itself uses) so this test can drive the actual /vendor/verify/[token]
// flow without needing real email delivery.
test("vendor can sign in via magic link and see their dashboard", async ({ page }) => {
  // Default 90s test timeout split across waitForURL (60s) + the heading
  // check (30s) alone would already sum to 90s with nothing left for the
  // rest — and /vendor/[vendorId]/dashboard is a different next dev route
  // than /vendor/verify/[token], so it can need its own first-hit compile
  // too. 150s gives both steps real independent headroom.
  test.setTimeout(150000);
  const fixtures = readFixtures();

  // 60s, not 30s: this redirect depends on both a cold Neon query AND
  // next dev compiling /vendor/verify/[token] on its first hit in this run
  // (see playwright.config.ts's own comment on Neon cold-start) — on a
  // slower CI runner the two stack and can exceed 30s even though 30s is
  // plenty locally. Confirmed flaky in CI at 30s (timed out twice, including
  // after the suite's own retries:1 retry) before this was raised.
  await page.goto(`/vendor/verify/${fixtures.vendorVerifyToken}`);
  await page.waitForURL(/\/vendor\/.+\/dashboard/, { timeout: 60000 });

  // See playwright.config.ts's own comment — Neon's compute can take 25-30s
  // to wake from idle on the first query after a while.
  await expect(page.getByRole("heading", { name: fixtures.vendorName })).toBeVisible({ timeout: 30000 });
  // Rendered with a curly apostrophe (Today&rsquo;s) — match loosely rather
  // than depend on the exact glyph.
  await expect(page.getByText(/Today.s sales/i)).toBeVisible();
  await expect(page.getByText(/Today.s transactions/i)).toBeVisible();
});
