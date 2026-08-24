import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));

// The schema is Postgres-only (see prisma/schema.prisma), so tests need a
// real Postgres target too — TEST_DATABASE_URL should point at a disposable
// database (e.g. a dedicated Neon branch), never the dev/pilot database:
// this runs `db push --accept-data-loss` against it on every test run.
export default function globalSetup() {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl) {
    throw new Error(
      "TEST_DATABASE_URL is not set — tests need their own disposable Postgres database (see .env.example)."
    );
  }

  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    cwd: dir,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
    stdio: "inherit",
  });
}
