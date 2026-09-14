import { test, expect } from "@playwright/test";
import { LoginPage } from "./pages/LoginPage";
import { prisma, readFixtures, resetLoginRateLimit } from "./fixtures/db";

// Buys on the OFFLINE_DEFERRED path (see src/app/events/[slug]/page.tsx) by
// faking navigator.onLine + the online/offline window events right before
// paying — this is a first-class, intentionally-supported mode ("pay at
// event", reconciled by the organizer later), not a workaround, and it
// avoids needing a real or mocked mobile-money gateway to complete the
// purchase. This only fakes what src/lib/sync-engine.ts's useOnlineStatus()
// checks, rather than Playwright's own context.setOffline() (real network
// cutoff), which broke the app's own client-side router navigation.
async function setSimulatedOnline(page: import("@playwright/test").Page, online: boolean) {
  await page.evaluate((isOnline) => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => isOnline });
    window.dispatchEvent(new Event(isOnline ? "online" : "offline"));
  }, online);
}

test.describe("ticket purchase", () => {
  let orderClientId: string | null = null;

  test.afterEach(async () => {
    if (!orderClientId) return;
    await prisma.order.delete({ where: { clientId: orderClientId } }).catch(() => {});
    orderClientId = null;
  });

  test("buyer can purchase a ticket offline, see the QR confirmation, and find it in My Tickets", async ({ page }) => {
    const fixtures = readFixtures();
    await resetLoginRateLimit(fixtures.fanEmail);
    const login = new LoginPage(page);
    await login.goto(`/events/${fixtures.generalEventSlug}`);
    await login.loginAndWait(fixtures.fanEmail, fixtures.demoPassword, /\/events\//);

    // Dexie needs to sync the fixture event down before it renders. See
    // playwright.config.ts's own comment — Neon's compute can take 25-30s to
    // wake from idle on the first query after a while.
    await expect(page.getByRole("heading", { name: fixtures.generalEventTitle })).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(fixtures.ticketTypeName)).toBeVisible();

    // The fixture event has exactly one ticket type, so there's exactly one
    // quantity "+" button on the page.
    await page.getByRole("button", { name: "+", exact: true }).click();
    await page.getByRole("button", { name: "Continue" }).click();

    // Now on the "confirm & pay" step — go offline before paying so this
    // resolves instantly via OFFLINE_DEFERRED instead of needing a real
    // mobile money confirmation.
    await setSimulatedOnline(page, false);
    await expect(page.getByText(/even offline/)).toBeVisible();
    await page.getByRole("button", { name: /^Pay / }).click();

    await page.waitForURL(/\/orders\/.+/, { timeout: 30000 });
    orderClientId = page.url().split("/orders/")[1];
    expect(orderClientId).toBeTruthy();

    await expect(page.getByRole("heading", { name: "You're going!" })).toBeVisible();
    await expect(page.getByText("Valid")).toBeVisible();
    const ticketCode = await page.locator("p.font-mono").first().textContent();
    expect(ticketCode?.trim().length).toBeGreaterThan(0);

    // Back online — the queued SELL_TICKETS op should flush and sync.
    await setSimulatedOnline(page, true);

    // "My Tickets" also appears as a Navbar link — scope to the confirmation
    // page's own button to avoid a strict-mode ambiguity.
    await page.getByRole("main").getByRole("link", { name: "My Tickets" }).click();
    await expect(page).toHaveURL(/\/account\/tickets/);
    const orderRow = page.locator(".card", { hasText: fixtures.generalEventTitle });
    await expect(orderRow).toBeVisible({ timeout: 30000 });
    await expect(orderRow.getByText("Confirmed")).toBeVisible({ timeout: 30000 });
  });
});
