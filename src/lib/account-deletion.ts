import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";

// A single shared placeholder User that Orders/Tickets get repointed to on
// self-deletion (see deleteOwnAccount below) — the "generic sentinel"
// Order.userId/Ticket.currentHolderUserId end up on, so a deleted attendee's
// purchase history reads as "Deleted User" rather than resolving back to one
// specific (even if already-anonymized) account. Lazily created on first use
// rather than seeded, same as any other singleton row this codebase doesn't
// pre-provision.
const DELETED_USER_SENTINEL_EMAIL = "deleted-user@chaap.internal";

// Wallet can't use this same sentinel: @@unique([eventId, ownerUserId]) means
// at most one wallet per owner per event, so two different deleted attendees
// who both held a wallet at the same event could never both repoint to one
// shared id. Wallets are anonymized in place instead — they just keep
// pointing at the original (now-anonymized) User row, which is enough: the
// wallet carries no PII of its own beyond that ownerUserId link, and once the
// User row itself is scrubbed (see below) that link no longer resolves to
// anything identifying. Same reasoning covers every other User-FK this
// function deliberately leaves untouched (TicketTransfer.fromUserId,
// TicketListing.sellerId/buyerId, LoyaltyRedemption.userId,
// TicketGroup.leadUserId, FloatDeclaration, EventForecast, Vendor.ownerUserId)
// — none of them carry a unique-per-user constraint that would block a shared
// sentinel the way Wallet does, but none of them need one either, since the
// anonymized User row already breaks the identity link.
async function getOrCreateDeletedUserSentinel(tx: Prisma.TransactionClient) {
  const existing = await tx.user.findUnique({ where: { email: DELETED_USER_SENTINEL_EMAIL } });
  if (existing) return existing;
  const passwordHash = await bcrypt.hash(randomUUID(), 10);
  return tx.user.create({
    data: {
      name: "Deleted User",
      email: DELETED_USER_SENTINEL_EMAIL,
      passwordHash,
      role: "USER",
    },
  });
}

// Safety gate: an attendee who also owns an organization can't vanish out
// from under an event that hasn't happened yet (or is happening right now) —
// there'd be nobody left to run it, answer support tickets, or receive the
// payout. Membership.role OWNER is always the organization's sole owner by
// design (invites only ever grant STAFF/GATE_CREW — see the OrganizationInvite
// model comment), so "sole owner" reduces to just "is an OWNER at all". A
// STAFF member of someone else's org, or an attendee with no org activity
// beyond their own auto-created personal one, is never blocked.
export async function getAccountDeletionBlock(userId: string): Promise<string | null> {
  const membership = await prisma.organizationMembership.findUnique({
    where: { userId },
    select: { role: true, organizationId: true },
  });
  if (!membership || membership.role !== "OWNER") return null;

  const now = new Date();
  const blockingEvent = await prisma.event.findFirst({
    where: {
      organizationId: membership.organizationId,
      status: "LIVE",
      OR: [{ endsAt: { gte: now } }, { endsAt: null, startsAt: { gte: now } }],
    },
    select: { title: true },
  });

  if (!blockingEvent) return null;
  return `You organize "${blockingEvent.title}", which is upcoming or in progress. Transfer ownership or wait until it concludes before deleting your account.`;
}

// PDPA self-deletion: anonymizes the User row (never deleted — see the
// model comment on Order.userId/Ticket for why every other record keeps a
// valid FK), signs out every device, and removes the two token tables tied
// 1:1 to this user's own login (password reset tokens; vendor/sponsor magic
// links are a different mechanism entirely — see VendorMagicLinkToken/
// SponsorMagicLinkToken, which key off Vendor/Sponsor contact info, not User).
export async function deleteOwnAccount(userId: string) {
  const block = await getAccountDeletionBlock(userId);
  if (block) {
    throw new Error(block);
  }

  const organizationId = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new Error("Account not found.");

    const sentinel = await getOrCreateDeletedUserSentinel(tx);

    await tx.order.updateMany({ where: { userId }, data: { userId: sentinel.id } });
    await tx.ticket.updateMany({ where: { currentHolderUserId: userId }, data: { currentHolderUserId: sentinel.id } });

    await tx.userSession.deleteMany({ where: { userId } });
    await tx.passwordResetToken.deleteMany({ where: { userId } });

    const unusablePasswordHash = await bcrypt.hash(randomUUID(), 10);
    await tx.user.update({
      where: { id: userId },
      data: {
        name: "Deleted User",
        email: `deleted-${userId}@deleted.chaap.africa`,
        phone: null,
        passwordHash: unusablePasswordHash,
      },
    });

    const membership = await tx.organizationMembership.findUnique({ where: { userId } });
    return membership?.organizationId ?? null;
  });

  // Logged after commit, same discipline as every other logAudit call (see
  // logAudit's own header comment in audit.ts) — and deliberately scrubbed of the real
  // name/email: an account-deletion request shouldn't leave the PII it asked
  // to remove sitting in a second table.
  if (organizationId) {
    await logAudit({
      organizationId,
      actorUserId: userId,
      actorName: "Deleted User",
      action: "ACCOUNT_DELETED",
      summary: "Account self-deleted and anonymized",
    });
  }
}
