import { test, expect } from "@playwright/test";
import { LoginPage } from "./pages/LoginPage";
import { readFixtures, resetLoginRateLimit } from "./fixtures/db";

test("vendor terminal charges a wallet by manually entered code", async ({ page }) => {
  const fixtures = readFixtures();
  await resetLoginRateLimit(fixtures.organizerEmail);
  const login = new LoginPage(page);

  await login.goto(`/scan/${fixtures.generalEventId}/wallet`);
  await login.loginAndWait(fixtures.organizerEmail, fixtures.demoPassword, /\/scan\/.+\/wallet/);

  await expect(page.getByRole("heading", { name: "Wallet charge terminal" })).toBeVisible({ timeout: 30000 });

  // Dexie needs to sync the fixture vendor down before it appears as an
  // option. This can take a while — Neon's compute suspends after
  // inactivity and the first query after a while can take 25-30s to resolve
  // (see playwright.config.ts's own comment on the same behavior).
  await expect(page.locator("#vendor")).toContainText(fixtures.vendorName, { timeout: 75000 });
  await page.locator("#vendor").selectOption({ label: fixtures.vendorName });

  // Charge well under the fixture wallet's balance so this resolves as a
  // plain success instead of the insufficient-balance split-payment prompt.
  await page.locator("#amount").fill("5000");
  await page.getByPlaceholder("Enter or scan wallet code").fill(fixtures.walletCode);
  await page.getByRole("button", { name: "Charge", exact: true }).click();

  await expect(page.getByText(/Charged.*5,000/)).toBeVisible({ timeout: 30000 });
});
