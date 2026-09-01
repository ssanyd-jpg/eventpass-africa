import { prisma } from "@/lib/prisma";

// Deterministic same-category recommendations — not Claude-backed. This is
// a filter query, not a generative/reasoning task, so it's computed the
// same way every other derived list in this codebase is: a pure Prisma
// fetcher. Structured identically to getPendingSurveysForBuyer
// (survey-handlers.ts) — same "piggyback on the pull poll, no background
// job runner" reasoning applies here too.
//
// Only returns event IDs, not full event shapes: every LIVE event's full
// LocalEvent record already rides in the unconditional `events` field of
// every pull response (see pull/route.ts's top-level `events` payload), so
// duplicating title/venue/ticketTypes/etc. here would just be redundant
// data on the wire — the client looks the ids up against its already-synced
// db.events table.
export async function getRecommendedEventIdsForBuyer(userId: string): Promise<string[]> {
  const pastOrders = await prisma.order.findMany({
    where: { userId, status: { in: ["PAID", "NEEDS_REVIEW"] } },
    select: { eventId: true, event: { select: { category: true } } },
    distinct: ["eventId"],
  });
  if (pastOrders.length === 0) return []; // no purchase history → no signal, don't guess

  const purchasedCategories = Array.from(new Set(pastOrders.map((o) => o.event.category)));
  const purchasedEventIds = pastOrders.map((o) => o.eventId);

  const recommended = await prisma.event.findMany({
    where: {
      category: { in: purchasedCategories },
      status: "LIVE",
      startsAt: { gt: new Date() },
      id: { notIn: purchasedEventIds },
    },
    orderBy: { startsAt: "asc" },
    take: 6,
    select: { id: true },
  });
  return recommended.map((e) => e.id);
}
