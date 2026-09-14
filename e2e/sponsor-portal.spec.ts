import { test, expect } from "@playwright/test";
import { readFixtures } from "./fixtures/db";

// Same magic-link mechanism as vendor-portal.spec.ts, mirrored for sponsors
// (see src/lib/sponsor-auth.ts) — the token is generated directly via Prisma
// in e2e/global-setup.ts rather than scraped from a real email.
test("sponsor can sign in via magic link and see their dashboard", async ({ page }) => {
  const fixtures = readFixtures();

  await page.goto(`/sponsor/verify/${fixtures.sponsorVerifyToken}`);
  await page.waitForURL(/\/sponsor\/.+\/dashboard/, { timeout: 30000 });

  // See playwright.config.ts's own comment — Neon's compute can take 25-30s
  // to wake from idle on the first query after a while.
  await expect(page.getByRole("heading", { name: fixtures.sponsorName })).toBeVisible({ timeout: 30000 });
  // "Zone stats" — the sponsor dashboard's own equivalent is booth-tap
  // activity: total taps today plus unique-attendee/dwell-time breakdowns.
  await expect(page.getByText("Wristband taps today")).toBeVisible();
  // "Unique attendees" also appears inside a longer sentence further down
  // the page ("Sponsorship fee ÷ unique attendees...") — match the stat
  // label exactly so this doesn't hit a strict-mode ambiguity.
  await expect(page.getByText("Unique attendees", { exact: true })).toBeVisible();
});
