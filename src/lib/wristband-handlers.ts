import crypto from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { generateTicketCode } from "@/lib/format";

// Extracted from the provisioning Server Action for the same reason
// credential-handlers.ts/crm-handlers.ts are separate from theirs: testable
// without HTTP/session plumbing.
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

type AttendeeInput = { userId: string } | { email: string; name: string };

export async function provisionWristband(
  organizationId: string,
  eventId: string,
  nfcUid: string,
  actorUserId: string,
  actorName: string,
  attendee: AttendeeInput
) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event || event.organizationId !== organizationId) {
    throw new Error("Event not found.");
  }

  return prisma.$transaction(
    async (tx) => {
      let user;
      if ("userId" in attendee) {
        user = await tx.user.findUniqueOrThrow({ where: { id: attendee.userId }, select: userSelect });
      } else {
        user = await tx.user.findUnique({ where: { email: attendee.email }, select: userSelect });
        if (!user) {
          // No account yet (a walk-up attendee) — create a real, functional
          // User row with a random password nobody knows. They can later
          // claim it via the existing generic "forgot password" flow (which
          // already works for any email with a User row, regardless of how
          // its hash was set) — same shape as a normal door-sale account.
          const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
          user = await tx.user.create({
            data: { name: attendee.name, email: attendee.email, passwordHash },
            select: userSelect,
          });
        }
      }

      let wallet = await tx.wallet.findUnique({
        where: { eventId_ownerUserId: { eventId: event.id, ownerUserId: user.id } },
      });
      if (!wallet) {
        wallet = await tx.wallet.create({
          data: { code: generateTicketCode(), eventId: event.id, ownerUserId: user.id, currency: event.currency },
        });
      }

      // Best-effort, read-only — a Ticket only exists via a completed order,
      // never created here. Covers both the original buyer and someone who
      // received this ticket via an accepted transfer.
      const ticket = await tx.ticket.findFirst({
        where: {
          eventId: event.id,
          order: { status: { in: ["PAID", "NEEDS_REVIEW"] } },
          OR: [{ order: { userId: user.id } }, { currentHolderUserId: user.id }],
        },
      });

      // A physical tag can only meaningfully belong to one person at a time
      // — supersede anything ACTIVE that collides on this uid, OR on the
      // wallet/ticket we're about to (re-)link, before creating new rows.
      await tx.credential.updateMany({
        where: {
          organizationId,
          status: "ACTIVE",
          OR: [{ nfcUid }, { walletId: wallet.id }, ...(ticket ? [{ ticketId: ticket.id }] : [])],
        },
        data: { status: "SUPERSEDED", supersededAt: new Date(), supersededByUserId: actorUserId },
      });

      await tx.credential.create({
        data: {
          organizationId,
          nfcUid,
          walletId: wallet.id,
          code: wallet.code,
          createdByUserId: actorUserId,
          createdByName: actorName,
        },
      });
      if (ticket) {
        await tx.credential.create({
          data: {
            organizationId,
            nfcUid,
            ticketId: ticket.id,
            code: ticket.code,
            createdByUserId: actorUserId,
            createdByName: actorName,
          },
        });
      }

      return { user, wallet, ticket, eventTitle: event.title };
    },
    { timeout: 15000, maxWait: 10000 }
  );
}
