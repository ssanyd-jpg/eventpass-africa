import { execSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.join(dir, "prisma", "test.db");

export default function globalSetup() {
  if (existsSync(testDbPath)) unlinkSync(testDbPath);

  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    cwd: dir,
    env: { ...process.env, DATABASE_URL: `file:${testDbPath}` },
    stdio: "inherit",
  });
}
