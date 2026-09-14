import { test, expect } from "@playwright/test";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { readFixtures, resetLoginRateLimit } from "./fixtures/db";

test("organizer can log in, see the dashboard, and log out", async ({ page }) => {
  const fixtures = readFixtures();
  await resetLoginRateLimit(fixtures.organizerEmail);
  const login = new LoginPage(page);
  const dashboard = new DashboardPage(page);

  await login.goto();
  await login.loginAndWait(fixtures.organizerEmail, fixtures.demoPassword, /\/$/);

  await dashboard.goto();
  // See playwright.config.ts's own comment — Neon's compute can take 25-30s
  // to wake from idle on the first query after a while.
  await expect(page.getByRole("heading", { name: /Organization$/ })).toBeVisible({ timeout: 30000 });
  await dashboard.expectLoaded();

  // Signing out from /dashboard races the sign-out button's own
  // router.push("/") against the dashboard page's own "redirect to login
  // when logged out" effect (both fire once the session clears) — which one
  // wins isn't meaningful to this test, so only the actual observable
  // result of signing out (no longer authenticated) is asserted.
  await dashboard.signOut();
  await expect(page.getByRole("link", { name: "Log in" })).toBeVisible();
});

test("wrong password shows an inline error and does not log in", async ({ page }) => {
  const fixtures = readFixtures();
  await resetLoginRateLimit(fixtures.organizerEmail);
  const login = new LoginPage(page);

  await login.goto();
  await login.login(fixtures.organizerEmail, "not-the-right-password");
  await login.expectError();
  await expect(page).toHaveURL(/\/login/);
});
