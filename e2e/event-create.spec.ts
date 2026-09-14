import { test, expect } from "@playwright/test";
import { LoginPage } from "./pages/LoginPage";
import { prisma, readFixtures, resetLoginRateLimit } from "./fixtures/db";

// Scope note (flagged, not a silent gap): the literal spec asked for
// "create a new event, add a ticket tier, add an access zone, publish".
// Exploration of the codebase found no "access zone" concept anywhere
// (no matching field, model, or UI), and no draft/publish flow — Event.status
// defaults to "LIVE" and src/app/dashboard/events/new/page.tsx sets it
// explicitly, so submitting the create form IS the publish action. This test
// covers everything that actually exists: title + one ticket tier, submitted
// in one step, then confirmed on the public listing.
test.describe("event creation", () => {
  let createdEventClientId: string | null = null;

  test.afterEach(async () => {
    if (!createdEventClientId) return;
    await prisma.event.delete({ where: { clientId: createdEventClientId } }).catch(() => {});
    createdEventClientId = null;
  });

  test("organizer can create an event with a ticket tier and it appears on the public events page", async ({ page }) => {
    const fixtures = readFixtures();
    await resetLoginRateLimit(fixtures.organizerEmail);
    const login = new LoginPage(page);
    await login.goto("/dashboard/events/new");
    await login.loginAndWait(fixtures.organizerEmail, fixtures.demoPassword, /\/dashboard\/events\/new/);

    const runId = Date.now().toString(36);
    const title = `E2E Created Event ${runId}`;

    await expect(page.getByRole("heading", { name: "Create an event" })).toBeVisible();
    await page.locator("#title").fill(title);
    await page.locator("#venue").fill("E2E Created Venue");
    await page.locator("#city").fill("Dodoma");
    const startsAt = new Date(Date.now() + 30 * 86400000);
    await page.locator("#startsAt").fill(startsAt.toISOString().slice(0, 16));

    // The ticket-tier row is part of the same create form — there's no
    // separate "add a ticket tier" step to visit.
    await page.getByPlaceholder("Name (e.g. General Admission)").fill("General Admission");
    await page.getByPlaceholder("Price (TZS)").fill("10000");
    await page.getByPlaceholder("Qty").fill("50");

    await page.getByRole("button", { name: "Create event" }).click();

    // Submitting IS the publish action — the event is LIVE immediately.
    await page.waitForURL(/\/dashboard\/events\/.+/, { timeout: 30000 });
    createdEventClientId = page.url().split("/dashboard/events/")[1];
    expect(createdEventClientId).toBeTruthy();

    await page.goto("/");
    await expect(page.getByText(title)).toBeVisible({ timeout: 30000 });
  });
});
