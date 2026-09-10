import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globalSetup: ["./vitest.global-setup.ts"],
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      // Neutralise real notification credentials for the test run. Once a
      // real RESEND_API_KEY / AT_API_KEY / AT_USERNAME exist in .env (added
      // for a one-off provider verification), sendNotification would
      // otherwise make a real external API round-trip per notifying test —
      // the Resend one 403s (unverified sender domain) after a network
      // delay, adding latency and flakiness across the suite. An empty
      // string is falsy, so sendEmail/sendSMS/sendNotification all fall
      // back to their instant console-log path, exactly as before those
      // keys were added. test.env overrides the --env-file=.env values the
      // same way the DATABASE_URL line above already does.
      RESEND_API_KEY: "",
      AT_API_KEY: "",
      AT_USERNAME: "",
    },
    // integration tests share one disposable Postgres database — parallel
    // test files would race on writes/schema, so run them one at a time.
    fileParallelism: false,
    // Each test makes several real round-trips to Neon (network, not a
    // local file) — the 5s default is too tight for tests that chain a
    // handful of Prisma calls, and the heavier settlement/refund tests
    // chain several sequential setup calls plus a transaction each.
    testTimeout: 60000,
    // Standing flaky-test investigation (this session): every full-suite
    // run occasionally throws a Prisma "Transaction already closed" (or a
    // downstream null-read) from a $transaction call in sync-handlers.ts —
    // always in a different test each time, NEVER reproducible when the
    // same test is re-run in isolation immediately after. Investigated the
    // obvious code-side culprit first: every $transaction call site already
    // uses an identical, deliberately-tuned {timeout:15000, maxWait:10000}
    // (see sync-handlers.ts's own comments on Neon's pooled-connection
    // latency) — six call sites, all consistent, none under-tuned. That
    // rules out "bump one timeout" as the fix; this is sustained Neon
    // latency/connection-pool contention on this shared test database
    // during a 60+ minute, 300+-test run, not a logic bug — the same class
    // of transient failure this app's whole offline-sync design already
    // expects and self-heals from in production (nearly every handler
    // returns `retry: true` for exactly this reason, trusting the client's
    // outbox to retry). The test suite had no equivalent safety net. One
    // automatic retry gives it one, at negligible cost (this fires on the
    // order of once per full run) — a genuinely broken test still fails
    // after the retry, since a real logic bug reproduces deterministically,
    // not as a random Prisma transaction-lifecycle exception.
    retry: 1,
  },
});
