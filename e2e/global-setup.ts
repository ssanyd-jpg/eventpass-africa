import { createHash, randomBytes } from "crypto";
import { writeFileSync } from "fs";
import { prisma, FIXTURES_PATH, resetLoginRateLimit, type E2EFixtures } from "./fixtures/db";

// Runs once before the whole E2E suite (see playwright.config.ts's
// globalSetup). Creates all the DB rows the spec files need directly via
// Prisma rather than through the UI, for the same reasons prisma/seed.ts and
// src/lib/test-fixtures.ts already do this for vitest: it's faster and
// deterministic, and some of what's needed (an approved vendor, a wallet with
// a real balance, a finished marathon leaderboard) would otherwise take many
// UI steps per test just to get to the starting line.
//
// This intentionally does NOT create its own Organization/User — it reuses
// the seeded organizer@chaap.dev/fan@chaap.dev demo accounts (see
// prisma/seed.ts) so login-based specs exercise the same accounts documented
// on the login page. Only a dedicated Event (plus everything nested under
// it — ticket types, orders, vendors, wallets, timing data) is created, and
// global-teardown.ts removes exactly that afterward, leaving the demo
// accounts and seeded events untouched.
//
// Flagged tradeoff: this runs against DATABASE_URL — the same Postgres
// database `next dev` uses for everyday local development — because no
// separate E2E database/server wiring exists yet (see e2e/README.md). Every
// row created here carries a per-run RUN_ID suffix so repeated runs never
// collide, and everything is deleted in global-teardown.ts.
function issueRawToken() {
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  return { rawToken, tokenHash };
}

// Neon's pooled (pgbouncer) connection can serve a read moments after a
// write through a DIFFERENT physical connection than the one that committed
// it — observed here as src/app/api/sync/pull/route.ts's Vendor/Sponsor/Order
// queries (each `include`s a required `event` relation) intermittently
// throwing "Inconsistent query result: Field event is required to return
// data, got null instead", or returning fewer rows than were just created,
// the first time the dev server's own Prisma client reads a row this script
// only just committed. Waiting for a plain read of our own to see the exact
// same shape cleanly, with a short retry, gives that visibility lag time to
// resolve before any spec starts driving the browser — a known class of
// PgBouncer/Postgres timing edge case, not a bug in the fixtures themselves.
async function waitForReadConsistency(label: string, read: () => Promise<unknown>) {
  const attempts = 10;
  for (let i = 1; i <= attempts; i++) {
    try {
      const result = await read();
      if (result != null) return;
    } catch {
      // fall through to retry — see this function's own comment above
    }
    if (i === attempts) {
      throw new Error(`e2e/global-setup: ${label} never became consistently readable after ${attempts} attempts.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

export default async function globalSetup() {
  const runId = Date.now().toString(36);
  const demoPassword = "password123";

  const organizer = await prisma.user.findUniqueOrThrow({ where: { email: "organizer@chaap.dev" } });
  const fan = await prisma.user.findUniqueOrThrow({ where: { email: "fan@chaap.dev" } });

  // Belt-and-suspenders reset — each individual spec also resets its own
  // login's rate-limit bucket right before it logs in (see
  // resetLoginRateLimit's own comment in e2e/fixtures/db.ts), but clearing
  // both here too means a run started shortly after a previous one doesn't
  // start already partway through the budget.
  await resetLoginRateLimit(organizer.email);
  await resetLoginRateLimit(fan.email);
  const membership = await prisma.organizationMembership.findFirstOrThrow({
    where: { userId: organizer.id, role: "OWNER" },
  });
  const organizationId = membership.organizationId;

  const ticketTypeName = "General Admission";
  const ticketTypePriceCents = 500000; // TZS 5,000
  const generalEventTitle = `E2E General Event ${runId}`;
  const event = await prisma.event.create({
    data: {
      slug: `e2e-general-${runId}`,
      title: generalEventTitle,
      description: "Fixture event created by Playwright global setup — safe to ignore.",
      category: "Music",
      venue: "E2E Test Venue",
      city: "Dar es Salaam",
      startsAt: new Date(Date.now() + 7 * 86400000),
      imageUrl: "https://picsum.photos/seed/e2e-general/1200/675",
      currency: "TZS",
      organizationId,
      ticketTypes: { create: [{ name: ticketTypeName, priceCents: ticketTypePriceCents, quantityTotal: 100 }] },
    },
    include: { ticketTypes: true },
  });
  const ticketType = event.ticketTypes[0];

  // A PAID ticket for gate-scan.spec — check in once, then confirm a second
  // scan of the same code is rejected as already checked in.
  const gateTicketCode = `E2EGATE${runId}`.toUpperCase();
  await prisma.order.create({
    data: {
      status: "PAID",
      totalCents: ticketType.priceCents,
      currency: "TZS",
      paymentMethod: "OFFLINE_DEFERRED",
      userId: fan.id,
      eventId: event.id,
      items: { create: [{ quantity: 1, unitPriceCents: ticketType.priceCents, ticketTypeId: ticketType.id }] },
      tickets: { create: [{ code: gateTicketCode, eventId: event.id, ticketTypeId: ticketType.id }] },
    },
  });

  // An APPROVED vendor with a real contact email — vendor-terminal.spec
  // charges against it, vendor-portal.spec logs into its magic-link portal.
  const vendorName = `E2E Vendor ${runId}`;
  const vendor = await prisma.vendor.create({
    data: {
      eventId: event.id,
      name: vendorName,
      category: "Food",
      status: "APPROVED",
      contactEmail: `e2e-vendor-${runId}@test.local`,
      badgeCode: `E2EVBADGE${runId}`.toUpperCase(),
    },
  });

  // A wallet with a real balance for fan@chaap.dev at this event — lets
  // vendor-terminal.spec charge it without a real mobile-money top-up.
  const walletBalanceCents = 2000000; // TZS 20,000
  const wallet = await prisma.wallet.create({
    data: {
      eventId: event.id,
      ownerUserId: fan.id,
      code: `E2EWALLET${runId}`.toUpperCase(),
      balanceCents: walletBalanceCents,
      currency: "TZS",
    },
  });

  // A sponsor with a real contact email — sponsor-portal.spec logs into its
  // magic-link portal.
  const sponsorName = `E2E Sponsor ${runId}`;
  const sponsor = await prisma.sponsor.create({
    data: {
      eventId: event.id,
      name: sponsorName,
      tier: "Gold",
      contactEmail: `e2e-sponsor-${runId}@test.local`,
    },
  });

  // Vendor/sponsor magic-link tokens, generated the exact same way
  // generateVendorMagicLink/generateSponsorMagicLink do (src/lib/vendor-auth.ts,
  // src/lib/sponsor-auth.ts) — a raw token whose sha256 hash alone is
  // persisted. Reproduced directly here (rather than importing those
  // src/lib functions) to avoid pulling application code into the E2E
  // fixtures layer; see e2e/fixtures/db.ts's own comment on that choice.
  // This sidesteps the "no dev bypass for email delivery" gap the vendor/
  // sponsor portals have: normally a real email would carry this link.
  const vendorToken = issueRawToken();
  await prisma.vendorMagicLinkToken.create({
    data: { tokenHash: vendorToken.tokenHash, vendorId: vendor.id, expiresAt: new Date(Date.now() + 86400000) },
  });
  const sponsorToken = issueRawToken();
  await prisma.sponsorMagicLinkToken.create({
    data: { tokenHash: sponsorToken.tokenHash, sponsorId: sponsor.id, expiresAt: new Date(Date.now() + 86400000) },
  });

  // A MARATHON event with a finished race — leaderboard.spec needs finisher
  // data that no seeded event has (none of prisma/seed.ts's events set
  // eventType: "MARATHON"). Two ticket types so the leaderboard's race
  // filter dropdown actually renders (it's hidden when there's only one).
  const marathonRaceTicketTypeName = "10K Entry";
  const marathonOtherTicketTypeName = "Full Marathon Entry";
  const marathonEventTitle = `E2E Marathon ${runId}`;
  const marathon = await prisma.event.create({
    data: {
      slug: `e2e-marathon-${runId}`,
      title: marathonEventTitle,
      description: "Fixture event created by Playwright global setup — safe to ignore.",
      category: "Sports",
      venue: "E2E Test Course",
      city: "Moshi",
      startsAt: new Date(Date.now() - 3600000),
      imageUrl: "https://picsum.photos/seed/e2e-marathon/1200/675",
      currency: "TZS",
      eventType: "MARATHON",
      gunStartAt: new Date(Date.now() - 1800000),
      organizationId,
      ticketTypes: {
        create: [
          { name: marathonRaceTicketTypeName, priceCents: 250000, quantityTotal: 50 },
          { name: marathonOtherTicketTypeName, priceCents: 450000, quantityTotal: 50 },
        ],
      },
    },
    include: { ticketTypes: true },
  });
  const raceTicketType = marathon.ticketTypes.find((tt) => tt.name === marathonRaceTicketTypeName)!;
  const finishPoint = await prisma.timingPoint.create({
    data: { eventId: marathon.id, name: "Finish", sequenceOrder: 2, isFinish: true },
  });
  const marathonTicketCode = `E2EBIB${runId}`.toUpperCase();
  const marathonOrder = await prisma.order.create({
    data: {
      status: "PAID",
      totalCents: raceTicketType.priceCents,
      currency: "TZS",
      paymentMethod: "OFFLINE_DEFERRED",
      userId: fan.id,
      eventId: marathon.id,
      items: { create: [{ quantity: 1, unitPriceCents: raceTicketType.priceCents, ticketTypeId: raceTicketType.id }] },
      tickets: { create: [{ code: marathonTicketCode, eventId: marathon.id, ticketTypeId: raceTicketType.id }] },
    },
    include: { tickets: true },
  });
  const marathonTicket = marathonOrder.tickets[0];
  const finisherCredential = await prisma.credential.create({
    data: {
      code: marathonTicketCode,
      status: "ACTIVE",
      createdByUserId: organizer.id,
      createdByName: organizer.name,
      organizationId,
      ticketId: marathonTicket.id,
    },
  });
  await prisma.chipTime.create({
    data: {
      eventId: marathon.id,
      timingPointId: finishPoint.id,
      credentialId: finisherCredential.id,
      recordedAt: new Date(),
      gunTimeOffsetSeconds: 1800, // 30:00 gun time
    },
  });

  // See waitForReadConsistency's own comment — confirms every row a spec
  // depends on syncing down is actually visible through its real join shape
  // before any test starts, rather than each spec discovering a transient
  // Neon/PgBouncer visibility lag on its own.
  await waitForReadConsistency("order", () =>
    prisma.order.findFirst({ where: { eventId: event.id }, include: { event: true } }).then((o) => o?.event ?? null)
  );
  await waitForReadConsistency("vendor", () =>
    prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id }, include: { event: true } }).then((v) => v.event ?? null)
  );
  await waitForReadConsistency("sponsor", () =>
    prisma.sponsor.findUniqueOrThrow({ where: { id: sponsor.id }, include: { event: true } }).then((s) => s.event ?? null)
  );
  await waitForReadConsistency("wallet", () =>
    prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id }, include: { event: true } }).then((w) => w.event ?? null)
  );
  await waitForReadConsistency("marathon order", () =>
    prisma.order.findFirst({ where: { eventId: marathon.id }, include: { event: true } }).then((o) => o?.event ?? null)
  );

  const fixtures: E2EFixtures = {
    runId,
    organizerEmail: organizer.email,
    fanEmail: fan.email,
    demoPassword,
    generalEventId: event.id,
    generalEventSlug: event.slug,
    generalEventTitle,
    ticketTypeName,
    ticketTypePriceCents,
    gateTicketCode,
    vendorId: vendor.id,
    vendorName,
    vendorBadgeCode: vendor.badgeCode!,
    walletCode: wallet.code,
    walletBalanceCents,
    sponsorId: sponsor.id,
    sponsorName,
    vendorVerifyToken: vendorToken.rawToken,
    sponsorVerifyToken: sponsorToken.rawToken,
    marathonEventId: marathon.id,
    marathonEventSlug: marathon.slug,
    marathonEventTitle,
    marathonRaceTicketTypeName,
    marathonOtherTicketTypeName,
  };
  writeFileSync(FIXTURES_PATH, JSON.stringify(fixtures, null, 2));

  await prisma.$disconnect();
}
