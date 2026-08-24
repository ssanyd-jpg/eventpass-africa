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
    },
    // integration tests share one disposable Postgres database — parallel
    // test files would race on writes/schema, so run them one at a time.
    fileParallelism: false,
    // Each test makes several real round-trips to Neon (network, not a
    // local file) — the 5s default is too tight for tests that chain a
    // handful of Prisma calls, and the heavier settlement/refund tests
    // chain several sequential setup calls plus a transaction each.
    testTimeout: 45000,
  },
});
