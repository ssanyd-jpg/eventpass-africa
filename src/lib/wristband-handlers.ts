import { prisma } from "@/lib/prisma";

// Read-only attendee search for the wristband-provisioning UI's online
// path. Provisioning itself (the mutation) is now handleProvisionCredential
// in sync-handlers.ts, an outbox op — this file keeps only the search,
// which stays a Server Action since it's a live query against every
// attendee's name/email, never shipped into local IndexedDB (see that
// handler's PII-exposure design note).
//
// Does NOT touch handleCheckIn/handleChargeWallet in sync-handlers.ts —
// those keep doing findUnique({where:{code}}) against Ticket/Wallet
// directly, unchanged. NFC resolution is a purely client-side Dexie lookup
// (see src/lib/credentials.ts) that translates a tag's uid into a `code`
// BEFORE calling the existing offline-sync ops — the server never gains a
// new uid-aware lookup path.

const userSelect = { id: true, name: true, email: true } as const;

export async function findAttendeeCandidates(organizationId: string, eventId: string, query: string) {
  const trimmed = query.trim();
  if (!trimmed) return [];

  // Ticket-code match first — the fast path for "attendee is holding their
  // ticket right now." Case-insensitive: unlike handleCheckIn's gate-scan
  // hot path (which can rely on the scanner UI always normalizing input),
  // this is a plain search box, so match regardless of how it was typed.
  const byCode = await prisma.ticket.findFirst({
    where: { code: { equals: trimmed, mode: "insensitive" } },
    include: { event: { select: { id: true, organizationId: true } }, order: { select: { userId: true } } },
  });
  if (byCode && byCode.event.id === eventId && byCode.event.organizationId === organizationId) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: byCode.order.userId }, select: userSelect });
    return [user];
  }

  // Otherwise name/email substring match, scoped to people who've bought
  // something at one of THIS organizer's events — never a global user search.
  return prisma.user.findMany({
    where: {
      orders: { some: { event: { organizationId } } },
      OR: [
        { email: { contains: trimmed, mode: "insensitive" } },
        { name: { contains: trimmed, mode: "insensitive" } },
      ],
    },
    select: userSelect,
    take: 10,
  });
}
