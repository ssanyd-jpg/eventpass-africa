import { randomBytes, createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/notifications";

// Business logic behind the ticket-transfer routes, extracted out of the
// route files for the same reason sync-handlers.ts is — testable directly,
// without going through HTTP/session plumbing. Structurally a copy of
// OrganizationInvite's hashed-token + expiry shape (see
// src/app/api/organization/invite/route.ts), with cancellation added — see
// TicketTransfer's schema comment for why.

const TRANSFER_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

// Whoever holds the ticket right now — a transfer target if one was ever
// accepted, else the order's own buyer. Same fallback shapeOrder/pull use.
function currentHolder(ticket: { currentHolderUserId: string | null; order: { userId: string } }) {
  return ticket.currentHolderUserId ?? ticket.order.userId;
}

export async function createTransfer(fromUserId: string, ticketId: string, toEmail: string) {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: { order: { select: { userId: true } }, event: { select: { title: true } } },
  });
  if (!ticket) {
    return { ok: false as const, error: "Ticket not found." };
  }
  if (currentHolder(ticket) !== fromUserId) {
    return { ok: false as const, error: "This isn't your ticket to transfer." };
  }
  if (ticket.checkedIn) {
    return { ok: false as const, error: "This ticket has already been checked in and can't be transferred." };
  }

  const normalizedEmail = toEmail.trim().toLowerCase();

  const rawToken = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + TRANSFER_EXPIRY_MS);
  const created = await prisma.ticketTransfer.create({
    data: {
      tokenHash: hashToken(rawToken),
      toEmail: normalizedEmail,
      fromUserId,
      ticketId: ticket.id,
      expiresAt,
    },
  });

  const acceptUrl = `${process.env.NEXTAUTH_URL ?? ""}/tickets/transfer/${rawToken}`;
  await sendNotification({
    type: "TICKET_TRANSFER",
    channel: "EMAIL",
    recipient: normalizedEmail,
    subject: `You've been sent a ticket to ${ticket.event.title}`,
    body: `Hi, you've been sent a ticket to ${ticket.event.title}. Accept it here (expires in 7 days): ${acceptUrl}`,
  });

  // Returned so the caller (OrderConfirmation's TransferControl) can offer
  // an immediate "Cancel" without needing a page refresh to learn this
  // transfer's real id via the separate GET-pending-transfers endpoint.
  return { ok: true as const, id: created.id, toEmail: normalizedEmail, expiresAt: expiresAt.toISOString() };
}

// Public-ish lookup by raw token — same threat model as an invite link:
// only someone with the token (the recipient, or someone it was forwarded
// to) can resolve it. Returns just enough for the accept page to render its
// two branches (existing-account sign-in vs inline sign-up) without leaking
// anything beyond what the token itself already grants.
export async function getTransferByToken(rawToken: string) {
  const transfer = await prisma.ticketTransfer.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { ticket: { include: { event: { select: { title: true } }, ticketType: { select: { name: true } } } } },
  });
  if (!transfer) return null;

  const hasAccount = !!(await prisma.user.findUnique({ where: { email: transfer.toEmail }, select: { id: true } }));

  return {
    status: transfer.status,
    expired: transfer.status === "PENDING" && transfer.expiresAt < new Date(),
    toEmail: transfer.toEmail,
    hasAccount,
    eventTitle: transfer.ticket.event.title,
    ticketTypeName: transfer.ticket.ticketType.name,
  };
}

export async function acceptTransfer(rawToken: string, userId: string, userEmail: string) {
  const transfer = await prisma.ticketTransfer.findUnique({ where: { tokenHash: hashToken(rawToken) } });
  if (!transfer || transfer.status !== "PENDING" || transfer.expiresAt < new Date()) {
    return { ok: false as const, error: "This transfer link is invalid or has expired." };
  }
  if (transfer.toEmail.toLowerCase() !== userEmail.toLowerCase()) {
    return { ok: false as const, error: "This ticket was sent to a different email address." };
  }

  await prisma.$transaction([
    prisma.ticket.update({ where: { id: transfer.ticketId }, data: { currentHolderUserId: userId } }),
    prisma.ticketTransfer.update({
      where: { id: transfer.id },
      data: { status: "ACCEPTED", acceptedAt: new Date(), acceptedByUserId: userId },
    }),
  ]);

  // No notification back to the sender — matches OrganizationInvite's
  // accept route exactly (it sends nothing back either).
  return { ok: true as const };
}

export async function cancelTransfer(fromUserId: string, transferId: string) {
  const transfer = await prisma.ticketTransfer.findUnique({ where: { id: transferId } });
  if (!transfer || transfer.fromUserId !== fromUserId) {
    return { ok: false as const, error: "Transfer not found." };
  }
  if (transfer.status !== "PENDING") {
    return { ok: false as const, error: "This transfer can no longer be cancelled." };
  }
  await prisma.ticketTransfer.update({ where: { id: transfer.id }, data: { status: "CANCELLED" } });
  return { ok: true as const };
}

// Surfaced on the buyer's own order view (OrderConfirmation) so a pending
// transfer they sent can be cancelled from there.
export async function listPendingTransfersForTickets(ticketIds: string[]) {
  if (ticketIds.length === 0) return [];
  return prisma.ticketTransfer.findMany({
    where: { ticketId: { in: ticketIds }, status: "PENDING" },
    select: { id: true, ticketId: true, toEmail: true, expiresAt: true, fromUserId: true },
  });
}
