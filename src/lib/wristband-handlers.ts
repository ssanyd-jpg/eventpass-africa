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

// Discriminated by `kind` so the provisioning page can tell a real attendee
// account apart from a group member ticket, which has none (see
// Ticket.groupMemberName) — provisioning that case goes through
// handleProvisionCredential's ticketId path instead of userId/email.
export type AttendeeCandidate =
  | ({ kind: "user" } & { id: string; name: string; email: string })
  | {
      kind: "groupMember";
      ticketId: string;
      ticketCode: string;
      groupId: string;
      groupName: string;
      memberName: string;
      provisionedCount: number;
      totalMembers: number;
      sharedWalletId: string;
      sharedWalletCode: string;
      sharedWalletBalanceCents: number;
      currency: string;
    };

export async function findAttendeeCandidates(organizationId: string, eventId: string, query: string): Promise<AttendeeCandidate[]> {
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
    // Session 13 — a group-member ticket has no attendee account of its
    // own (order.userId is the LEAD buyer, not the person wearing this
    // wristband) — resolve it as a group-member candidate instead, carrying
    // enough live info (shared balance, provisioned/total) for the
    // provisioning page's confirmation to show.
    if (byCode.ticketGroupId) {
      const group = await prisma.ticketGroup.findUnique({
        where: { id: byCode.ticketGroupId },
        include: { sharedWallet: { select: { id: true, code: true, balanceCents: true, currency: true } } },
      });
      if (group) {
        const [totalMembers, provisionedCount] = await Promise.all([
          prisma.ticket.count({ where: { ticketGroupId: group.id } }),
          prisma.ticket.count({ where: { ticketGroupId: group.id, credentials: { some: { status: "ACTIVE" } } } }),
        ]);
        return [{
          kind: "groupMember",
          ticketId: byCode.id,
          ticketCode: byCode.code,
          groupId: group.id,
          groupName: group.name,
          memberName: byCode.groupMemberName ?? "Group member",
          provisionedCount,
          totalMembers,
          sharedWalletId: group.sharedWallet.id,
          sharedWalletCode: group.sharedWallet.code,
          sharedWalletBalanceCents: group.sharedWallet.balanceCents,
          currency: group.sharedWallet.currency,
        }];
      }
    }
    const user = await prisma.user.findUniqueOrThrow({ where: { id: byCode.order.userId }, select: userSelect });
    return [{ kind: "user", ...user }];
  }

  // Otherwise name/email substring match, scoped to people who've bought
  // something at one of THIS organizer's events — never a global user search.
  const users = await prisma.user.findMany({
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
  return users.map((u) => ({ kind: "user" as const, ...u }));
}
