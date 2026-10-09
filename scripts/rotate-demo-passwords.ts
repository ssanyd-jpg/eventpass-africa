/**
 * Rotates the password for the three hardcoded demo accounts
 * (organizer@chaap.dev, fan@chaap.dev, admin@chaap.dev) — these were
 * displayed in plain text, unconditionally, on the public /login page
 * (see src/app/login/page.tsx) until that was gated behind
 * `NODE_ENV !== "production"`. Gating the display doesn't change the
 * accounts themselves: anyone who already saw the page can still log in
 * with the old password until it's actually rotated here.
 *
 *   npx tsx --env-file=.env scripts/rotate-demo-passwords.ts                       # dry run (default): read-only report
 *   npx tsx --env-file=.env scripts/rotate-demo-passwords.ts --execute --host <host-substring>
 *
 * --host must be a substring of DATABASE_URL's host, same safety convention
 * as scripts/clear-seed-data.ts — the database being changed is always one
 * you named on the command line, never just whatever .env happens to point
 * at that day.
 *
 * Each account gets its own fresh, cryptographically random password
 * (32 hex chars), hashed with bcrypt at the same cost factor (10) the
 * register route already uses. The new passwords are printed to the
 * console ONCE — copy them into a password manager immediately, because
 * this script does not store them anywhere and cannot show them again.
 *
 * This only stops *future* logins with the old password. Sessions are
 * JWT-based (src/auth.config.ts), not database-backed, so anyone already
 * holding a valid session stays logged in until it expires on its own —
 * rotating NEXTAUTH_SECRET is the only way to force every session off
 * immediately, and that logs out every user on the platform, not just
 * these three, so only do that if you suspect the exposed admin login was
 * actually used, not just exposed.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

const DEMO_EMAILS = ["organizer@chaap.dev", "fan@chaap.dev", "admin@chaap.dev"];

const prisma = new PrismaClient();

function databaseHost(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return new URL(url).host;
}

async function main() {
  const execute = process.argv.includes("--execute");
  const hostArg = process.argv[process.argv.indexOf("--host") + 1];
  const host = databaseHost();
  console.log(`Database host: ${host}`);
  console.log(execute ? "Mode: EXECUTE" : "Mode: dry run (nothing will be changed)");

  if (execute) {
    if (!hostArg || !host.includes(hostArg)) {
      throw new Error(
        `--execute requires --host <substring-of-"${host}"> — refusing to guess which database you meant.`
      );
    }
  }

  const users = await prisma.user.findMany({
    where: { email: { in: DEMO_EMAILS } },
    select: { id: true, email: true, role: true },
  });

  if (users.length === 0) {
    console.log("None of the demo accounts exist on this database — nothing to do.");
    return;
  }

  console.log(`\nFound ${users.length} demo account(s) on this database:`);
  for (const u of users) console.log(`  - ${u.email}${u.role === "ADMIN" ? "  (ADMIN)" : ""}`);

  if (!execute) {
    console.log("\nDry run only — re-run with --execute --host <substring> to actually rotate these passwords.");
    return;
  }

  console.log("\nNew passwords (shown once — save these now):\n");
  for (const u of users) {
    const newPassword = randomBytes(16).toString("hex"); // 32 hex chars
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({ where: { id: u.id }, data: { passwordHash } });
    console.log(`  ${u.email}  /  ${newPassword}`);
  }
  console.log(
    "\nDone. The old passwords no longer work for new logins. Anyone with an existing " +
      "JWT session (see this script's header comment) stays signed in until that session " +
      "expires on its own."
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
