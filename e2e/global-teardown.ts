import { existsSync, unlinkSync } from "fs";
import { prisma, readFixtures, FIXTURES_PATH } from "./fixtures/db";

// Deletes everything global-setup.ts created, plus anything the spec files
// themselves created and cleaned up by clientId along the way (event-create
// and ticket-purchase specs do that inline in their own afterEach, since
// those rows don't exist until the test runs) — this only needs to remove
// the two fixture events. Order/Ticket rows don't cascade-delete from Event
// in this schema (see prisma/schema.prisma — every other Event-child relation
// does), so orders must be deleted first.
export default async function globalTeardown() {
  if (!existsSync(FIXTURES_PATH)) return; // global-setup never completed — nothing to clean up
  const fixtures = readFixtures();

  for (const eventId of [fixtures.generalEventId, fixtures.marathonEventId]) {
    await prisma.order.deleteMany({ where: { eventId } });
    await prisma.event.delete({ where: { id: eventId } }).catch(() => {
      // Already gone (e.g. a re-run after a partial failure) — fine.
    });
  }

  await prisma.$disconnect();
  unlinkSync(FIXTURES_PATH);
}
