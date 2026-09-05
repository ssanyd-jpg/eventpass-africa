import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));

// The schema is Postgres-only (see prisma/schema.prisma), so tests need a
// real Postgres target too — TEST_DATABASE_URL should point at a disposable
// database (e.g. a dedicated Neon branch), never the dev/pilot database.
export default function globalSetup() {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl) {
    throw new Error(
      "TEST_DATABASE_URL is not set — tests need their own disposable Postgres database (see .env.example)."
    );
  }

  // Both DATABASE_URL and DIRECT_URL must point at the test database for
  // this subprocess — schema.prisma's directUrl is what `db push`/`db
  // execute` actually use, so leaving DIRECT_URL inherited from the parent
  // process would silently target the dev database instead.
  const testEnv = { ...process.env, DATABASE_URL: testDatabaseUrl, DIRECT_URL: testDatabaseUrl };

  // `db push` only syncs schema — it never clears existing row data. Tests
  // use hardcoded ids (clientId, ticket codes), so leftover rows from a
  // prior run cause silent idempotency short-circuits instead of real
  // inserts. Drop and recreate the schema first for a genuinely clean slate
  // every run (this replaces the old SQLite version's "delete the file").
  execSync(`npx prisma db execute --stdin`, {
    cwd: dir,
    env: testEnv,
    input: "DROP SCHEMA public CASCADE;\nCREATE SCHEMA public;\n",
    stdio: ["pipe", "inherit", "inherit"],
  });

  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    cwd: dir,
    env: testEnv,
    stdio: "inherit",
  });

  // Neon's compute suspends after inactivity and can take several seconds
  // to resume on the first real query — without this, that cold-start
  // latency lands inside whichever test happens to run first (or, worse,
  // inside a concurrent-transaction test where it can blow past the
  // transaction's own timeout). db push above already touches the
  // database, but a plain query here is a cheap, explicit belt-and-
  // suspenders wake-up rather than relying on a schema operation's latency
  // profile to double as one.
  execSync(`npx prisma db execute --stdin`, {
    cwd: dir,
    env: testEnv,
    input: "SELECT 1;\n",
    stdio: ["pipe", "inherit", "inherit"],
  });
}
