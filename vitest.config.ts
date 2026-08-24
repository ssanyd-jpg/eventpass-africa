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
  },
});
