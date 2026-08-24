import path from "node:path";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globalSetup: ["./vitest.global-setup.ts"],
    env: {
      DATABASE_URL: `file:${path.join(__dirname, "prisma", "test.db")}`,
    },
    // integration tests share one real SQLite file — parallel test files
    // would race on writes/schema, so run them one at a time.
    fileParallelism: false,
  },
});
