import { defineConfig, devices } from "@playwright/test";

// E2E tests drive a real `next dev` server, which reads the same `.env` as
// the rest of the app (there's no separate NEXTAUTH_URL/DATABASE_URL wired
// up for E2E — see e2e/README.md for why that's a deliberate, flagged
// tradeoff rather than an oversight). RESEND_API_KEY/AT_API_KEY are blanked
// in the spawned server's own env below so notifications fall back to the
// safe NotificationLog-only path instead of sending real email/SMS — this
// only affects the process Playwright starts, never `npm run dev` itself.
export default defineConfig({
  testDir: "./e2e",
  // Serialized, not parallel — this app's Neon Postgres connection is a
  // pooled/pgbouncer one shared with everyday local dev (see e2e/README.md's
  // "runs against the dev database" tradeoff), and concurrent workers each
  // triggering their own NextAuth callback transaction reliably produced
  // "Unable to start a transaction in the given time" errors under the
  // default 4-worker parallelism. The same Neon-latency sensitivity has
  // shown up before in this project's vitest suite (see prior sessions).
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "list",
  // Neon's compute suspends after inactivity and can take 25-30s to wake on
  // the first query after a while — confirmed by direct measurement against
  // this project's own DATABASE_URL (a single /api/sync/pull call took
  // 25-30s cold, <1s once warm). The default 30s per-test timeout isn't
  // enough headroom for a spec whose very first assertion depends on a fresh
  // pull; 90s comfortably covers a cold start plus the rest of a normal test.
  timeout: 90000,
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "node --env-file=.env node_modules/next/dist/bin/next dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    env: {
      RESEND_API_KEY: "",
      AT_API_KEY: "",
      AT_USERNAME: "",
    },
  },
});
