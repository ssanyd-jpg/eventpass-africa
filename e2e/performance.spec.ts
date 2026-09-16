import { test, expect } from "@playwright/test";
import { readFixtures } from "./fixtures/db";

// Session 22 performance audit — a basic regression guard against a future
// change silently making one of the three most-trafficked pages slow.
//
// "Cold load" here means the first paint of that route for an already-
// warmed-up server, NOT literally the very first request of the whole test
// run: this suite runs against `next dev` (see playwright.config.ts), which
// JIT-compiles each route's webpack bundle on its first-ever request
// (several seconds, unrelated to anything this app's code controls) and
// against Neon, whose compute can take 25-30s to wake from idle (see the
// same config's own comment, and leaderboard.spec.ts's 30s assertion
// timeouts). Neither of those is the "is this page fast" signal this test
// is for, so each page gets one untimed warm-up navigation first — a real
// production deployment (pre-built, and hitting an already-awake database
// under normal traffic) never pays either cost on a genuine cold load.
const BUDGET_MS = 3000;

async function measureLoad(page: import("@playwright/test").Page, path: string): Promise<number> {
  await page.goto(path, { waitUntil: "load" }); // untimed warm-up
  const startedAt = Date.now();
  await page.goto(path, { waitUntil: "load" });
  return Date.now() - startedAt;
}

test("homepage loads within budget", async ({ page }) => {
  const ms = await measureLoad(page, "/");
  expect(ms, `homepage took ${ms}ms (budget ${BUDGET_MS}ms)`).toBeLessThan(BUDGET_MS);
});

test("event page loads within budget", async ({ page }) => {
  const fixtures = readFixtures();
  const ms = await measureLoad(page, `/events/${fixtures.generalEventSlug}`);
  expect(ms, `event page took ${ms}ms (budget ${BUDGET_MS}ms)`).toBeLessThan(BUDGET_MS);
});

test("public leaderboard loads within budget", async ({ page }) => {
  const fixtures = readFixtures();
  const ms = await measureLoad(page, `/events/${fixtures.marathonEventSlug}/leaderboard`);
  expect(ms, `leaderboard took ${ms}ms (budget ${BUDGET_MS}ms)`).toBeLessThan(BUDGET_MS);
});
