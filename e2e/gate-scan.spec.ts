import { test, expect } from "@playwright/test";
import { LoginPage } from "./pages/LoginPage";
import { ScanPage } from "./pages/ScanPage";
import { readFixtures, resetLoginRateLimit } from "./fixtures/db";

test("gate scanner checks a ticket in, then rejects a second scan as already checked in", async ({ page }) => {
  const fixtures = readFixtures();
  await resetLoginRateLimit(fixtures.organizerEmail);
  const login = new LoginPage(page);
  const scan = new ScanPage(page);

  await login.goto(`/scan/${fixtures.generalEventId}`);
  await login.loginAndWait(fixtures.organizerEmail, fixtures.demoPassword, /\/scan\//);

  await expect(page.getByRole("heading", { name: "Gate check-in" })).toBeVisible({ timeout: 30000 });

  // Dexie needs to sync the fixture ticket down before the scanner recognizes
  // its code at all. This can take a while — Neon's compute suspends after
  // inactivity and the first query after a while can take 25-30s to resolve
  // (confirmed by direct measurement against this project's own database;
  // see playwright.config.ts's own comment on the same behavior) — so this
  // retries the scan itself for a generous window rather than assuming a
  // fixed short sync delay. It also doesn't wait on an exact "N tickets"
  // count, since other specs may be selling/checking in tickets on this same
  // shared fixture event around the same time.
  await expect(async () => {
    await scan.checkIn(fixtures.gateTicketCode);
    await expect(page.getByText("Entry granted.")).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 75000 });

  await scan.checkIn(fixtures.gateTicketCode);
  await scan.expectAlreadyCheckedIn();
});
