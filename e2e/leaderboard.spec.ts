import { test, expect } from "@playwright/test";
import { readFixtures } from "./fixtures/db";

// Public, unauthenticated page — src/app/events/[slug]/leaderboard/page.tsx.
// No seeded event has marathon/timing data, so e2e/global-setup.ts builds a
// dedicated MARATHON fixture event with a gun start and one recorded finish,
// across two ticket types, so the race filter dropdown (hidden when there's
// only one ticket type) actually renders.
test("public leaderboard loads and the race filter narrows results", async ({ page }) => {
  const fixtures = readFixtures();

  await page.goto(`/events/${fixtures.marathonEventSlug}/leaderboard`);

  // See playwright.config.ts's own comment — Neon's compute can take 25-30s
  // to wake from idle on the first query after a while.
  await expect(page.getByRole("heading", { name: fixtures.marathonEventTitle })).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole("heading", { name: "Finishers" })).toBeVisible();
  await expect(page.getByText("Alex Rivera")).toBeVisible({ timeout: 30000 });

  const raceSelect = page.locator("#ticketType");
  await expect(raceSelect).toBeVisible();

  // The fixture finisher raced under the "race" ticket type — filtering to
  // the other one should leave no finishers.
  await raceSelect.selectOption({ label: fixtures.marathonOtherTicketTypeName });
  await expect(page.getByText("No finishers yet.")).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("Alex Rivera")).not.toBeVisible();

  // Filtering back to the correct race brings the finisher back.
  await raceSelect.selectOption({ label: fixtures.marathonRaceTicketTypeName });
  await expect(page.getByText("Alex Rivera")).toBeVisible({ timeout: 30000 });
});
