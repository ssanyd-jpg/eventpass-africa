/**
 * Removes the demo events created by prisma/seed.ts — and only those.
 *
 *   npx tsx --env-file=.env scripts/clear-seed-data.ts                 # dry run (default): read-only report
 *   npx tsx --env-file=.env scripts/clear-seed-data.ts --execute --host <host-substring>
 *
 * What counts as seed data: an event whose slug is one of the six seed slugs
 * AND whose organization's members are all seed accounts (@chaap.dev, or @eventpassafrica.dev from before the rename). User
 * accounts are never deleted, seed or not.
 *
 * What it deletes, per seed event: the orders (with their order items,
 * tickets, transfers and registration answers), the event's ticket types,
 * wallets (with their transactions) and the event itself.
 *
 * "Do not touch real data" is enforced, not assumed: --execute refuses to run
 * (deleting nothing) if any seed event has anything that is not plain seed
 * data — an order or wallet owned by a non-seed account, or any vendor,
 * sponsor, volunteer, waitlist entry, broadcast, support ticket, settlement
 * line, discount code, etc. attached to it. Those need a human decision.
 * The deletes run in one transaction, so a failure part-way deletes nothing.
 *
 * --host must be a substring of the DATABASE_URL host, so the database being
 * changed is always one you named on the command line.
 */
import { PrismaClient } from "@prisma/client";

// Demo accounts: prisma/seed.ts today uses @chaap.dev; databases seeded before
// the EventPass Africa → Chaap rename hold the same accounts at @eventpassafrica.dev.
const SEED_EMAIL_DOMAINS = ["@chaap.dev", "@eventpassafrica.dev"];
const isSeedEmail = (email: string) => SEED_EMAIL_DOMAINS.some((d) => email.endsWith(d));
// prisma/seed.ts slugifies these titles.
const SEED_SLUGS = [
  "bongo-beats-festival",
  "dar-comedy-night",
  "kilimanjaro-marathon",
  "east-africa-tech-summit",
  "zanzibar-acoustic-sessions",
  "arusha-harvest-wine-fair",
];

// Event-scoped tables that seed.ts never writes to. Any row here means someone
// (or some test) used the event, so it is not "just seed data".
const ACTIVITY_TABLES = [
  "broadcast",
  "supportTicket",
  "registrationQuestion",
  "surveyQuestion",
  "discountCode",
  "ticketGroup",
  "timingPoint",
  "chipTime",
  "conferenceSession",
  "sessionAttendance",
  "densityAlert",
  "volunteer",
  "waitlistEntry",
  "vendor",
  "exhibitorLead",
  "sponsor",
  "floatDeclaration",
  "eventForecast",
] as const;

const prisma = new PrismaClient();

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function databaseHost(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return new URL(url).host;
}

async function main() {
  const execute = process.argv.includes("--execute");
  const host = databaseHost();
  console.log(`Database host: ${host}`);
  console.log(execute ? "Mode: EXECUTE" : "Mode: dry run (nothing will be changed)");

  const candidates = await prisma.event.findMany({
    where: { slug: { in: SEED_SLUGS } },
    select: {
      id: true,
      slug: true,
      title: true,
      status: true,
      organization: { select: { membership: { select: { user: { select: { email: true } } } } } },
    },
  });

  const seedEvents = candidates.filter((e) => {
    const emails = e.organization.membership.map((m) => m.user.email ?? "");
    return emails.length > 0 && emails.every(isSeedEmail);
  });
  const skipped = candidates.filter((e) => !seedEvents.includes(e));
  for (const e of skipped) {
    console.log(`SKIPPED ${e.slug}: its organization has a non-seed member, so it is not treated as seed data.`);
  }
  if (seedEvents.length === 0) {
    console.log("No seed events found. Nothing to do.");
    return;
  }

  const eventIds = seedEvents.map((e) => e.id);
  const seedUserIds = (
    await prisma.user.findMany({ where: { OR: SEED_EMAIL_DOMAINS.map((d) => ({ email: { endsWith: d } })) }, select: { id: true } })
  ).map((u) => u.id);

  const [orders, foreignOrders, tickets, ticketTypes, wallets, foreignWallets, walletTx, settlementItems] =
    await Promise.all([
      prisma.order.count({ where: { eventId: { in: eventIds } } }),
      prisma.order.count({ where: { eventId: { in: eventIds }, userId: { notIn: seedUserIds } } }),
      prisma.ticket.count({ where: { eventId: { in: eventIds } } }),
      prisma.ticketType.count({ where: { eventId: { in: eventIds } } }),
      prisma.wallet.count({ where: { eventId: { in: eventIds } } }),
      prisma.wallet.count({ where: { eventId: { in: eventIds }, ownerUserId: { notIn: seedUserIds } } }),
      prisma.walletTransaction.count({ where: { wallet: { eventId: { in: eventIds } } } }),
      prisma.settlementItem.count({ where: { order: { eventId: { in: eventIds } } } }),
    ]);

  const activity: Record<string, number> = {};
  for (const table of ACTIVITY_TABLES) {
    // Dynamic delegate access — every table above has an eventId column.
    const n = await (prisma as any)[table].count({ where: { eventId: { in: eventIds } } });
    if (n > 0) activity[table] = n;
  }
  if (settlementItems > 0) activity.settlementItem = settlementItems;

  console.log(`\nSeed events found (${seedEvents.length}):`);
  for (const e of seedEvents) console.log(`  ${e.slug}  [${e.status}]  ${e.title}`);
  console.log("\nWould delete:");
  console.log(`  events: ${seedEvents.length}, ticket types: ${ticketTypes}`);
  console.log(`  orders: ${orders}, tickets: ${tickets}`);
  console.log(`  wallets: ${wallets}, wallet transactions: ${walletTx}`);
  console.log(`  user accounts: 0 (never deleted)`);

  const blockers: string[] = [];
  if (foreignOrders > 0) blockers.push(`${foreignOrders} order(s) owned by non-seed accounts`);
  if (foreignWallets > 0) blockers.push(`${foreignWallets} wallet(s) owned by non-seed accounts`);
  for (const [table, n] of Object.entries(activity)) blockers.push(`${n} ${table} row(s) attached to seed events`);

  if (blockers.length > 0) {
    console.log("\nBLOCKED — this is not just seed data:");
    for (const b of blockers) console.log(`  - ${b}`);
    console.log("Nothing will be deleted while these exist. Review them, then remove or move them by hand.");
    if (execute) process.exitCode = 1;
    return;
  }

  if (!execute) {
    console.log("\nDry run only. To delete, re-run with: --execute --host <part of the host above>");
    return;
  }

  const hostArg = argValue("--host");
  if (!hostArg || !host.includes(hostArg)) {
    console.error(`\nRefusing to execute: --host must be given and must appear in "${host}".`);
    process.exitCode = 1;
    return;
  }

  await prisma.$transaction(
    async (tx) => {
      // Orders first: cascades to order items, tickets, ticket transfers and
      // registration answers. Tickets/Orders don't cascade from the event.
      await tx.order.deleteMany({ where: { eventId: { in: eventIds } } });
      // Cascades to ticket types, wallets and wallet transactions.
      await tx.event.deleteMany({ where: { id: { in: eventIds } } });
    },
    { timeout: 120_000, maxWait: 30_000 },
  );

  const remaining = await prisma.event.count({ where: { id: { in: eventIds } } });
  console.log(`\nDeleted. Seed events remaining: ${remaining}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
