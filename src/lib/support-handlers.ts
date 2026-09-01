import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { sendNotification } from "@/lib/notifications";

// Business logic behind the support-ticket routes/pages, extracted for
// direct testability — same reasoning as sync-handlers.ts/crm-handlers.ts.
//
// Plain Server Actions/functions, not queueOp/handle*/payloadSchemas —
// asking a question has no "poorly-connected venue, right now" urgency the
// way buying a ticket does; it's asynchronous by nature (the organizer
// answers hours/days later), same call TICKET_TRANSFER made for the same
// reason (see src/lib/ticket-transfer.ts).

const CREATE_TICKET_RATE_LIMIT = { limit: 5, windowMs: 60 * 60 * 1000 };

export async function createSupportTicket(buyerUserId: string, eventId: string, subject: string, body: string) {
  const { allowed } = await checkRateLimit(`support-ticket:${buyerUserId}`, CREATE_TICKET_RATE_LIMIT);
  if (!allowed) {
    return { ok: false as const, error: "Too many tickets opened recently. Try again later." };
  }

  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true, title: true, organizationId: true } });
  if (!event) {
    return { ok: false as const, error: "Event not found." };
  }

  const ticket = await prisma.supportTicket.create({
    data: {
      subject: subject.trim(),
      body: body.trim(),
      organizationId: event.organizationId,
      eventId: event.id,
      buyerUserId,
    },
  });

  // First-ever "notify the organizer" notification — every prior
  // sendNotification call in this codebase is buyer-directed. Sent to the
  // org's OWNER only (not every STAFF member — same single-recipient
  // simplicity as everything else in this v1 pass).
  const owner = await prisma.organizationMembership.findFirst({
    where: { organizationId: event.organizationId, role: "OWNER" },
    include: { user: { select: { email: true, name: true } } },
  });
  if (owner) {
    await sendNotification({
      type: "SUPPORT_TICKET_CREATED",
      channel: "EMAIL",
      recipient: owner.user.email,
      subject: `New support ticket: ${ticket.subject}`,
      body: `Hi ${owner.user.name}, a new support ticket was opened about ${event.title}: "${ticket.subject}". Reply from your dashboard.`,
    });
  }

  return { ok: true as const, ticketId: ticket.id };
}

async function requireOwnTicketAsBuyer(buyerUserId: string, ticketId: string) {
  const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
  if (!ticket || ticket.buyerUserId !== buyerUserId) {
    throw new Error("Ticket not found.");
  }
  return ticket;
}

async function requireOwnTicketAsOrg(organizationId: string, ticketId: string) {
  const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
  if (!ticket || ticket.organizationId !== organizationId) {
    throw new Error("Ticket not found.");
  }
  return ticket;
}

// A buyer reply reopens a RESOLVED ticket (they're still waiting on an
// answer); an organizer reply never changes status — resolving is a
// separate, explicit action.
export async function replyToSupportTicketAsBuyer(buyerUserId: string, ticketId: string, authorName: string, body: string) {
  const ticket = await requireOwnTicketAsBuyer(buyerUserId, ticketId);
  const reply = await prisma.$transaction([
    prisma.supportTicketReply.create({
      data: { ticketId: ticket.id, body: body.trim(), authorUserId: buyerUserId, authorName, isFromOrganizer: false },
    }),
    prisma.supportTicket.update({ where: { id: ticket.id }, data: { status: "OPEN", updatedAt: new Date() } }),
  ]);
  return reply[0];
}

export async function replyToSupportTicketAsOrganizer(
  organizationId: string,
  ticketId: string,
  authorUserId: string,
  authorName: string,
  body: string
) {
  const ticket = await requireOwnTicketAsOrg(organizationId, ticketId);
  const reply = await prisma.$transaction([
    prisma.supportTicketReply.create({
      data: { ticketId: ticket.id, body: body.trim(), authorUserId, authorName, isFromOrganizer: true },
    }),
    prisma.supportTicket.update({ where: { id: ticket.id }, data: { updatedAt: new Date() } }),
  ]);
  return reply[0];
}

export async function resolveSupportTicket(organizationId: string, ticketId: string) {
  const ticket = await requireOwnTicketAsOrg(organizationId, ticketId);
  if (ticket.status === "RESOLVED") return ticket; // idempotent
  return prisma.supportTicket.update({ where: { id: ticket.id }, data: { status: "RESOLVED" } });
}

export async function listSupportTicketsForOrg(organizationId: string, status?: string) {
  return prisma.supportTicket.findMany({
    where: { organizationId, ...(status ? { status } : {}) },
    include: { event: { select: { title: true } } },
    orderBy: { updatedAt: "desc" },
  });
}

export async function listSupportTicketsForBuyer(buyerUserId: string) {
  return prisma.supportTicket.findMany({
    where: { buyerUserId },
    include: { event: { select: { title: true } } },
    orderBy: { updatedAt: "desc" },
  });
}

export async function getSupportTicketDetailForBuyer(buyerUserId: string, ticketId: string) {
  const ticket = await requireOwnTicketAsBuyer(buyerUserId, ticketId);
  const replies = await prisma.supportTicketReply.findMany({ where: { ticketId: ticket.id }, orderBy: { createdAt: "asc" } });
  const event = ticket.eventId ? await prisma.event.findUnique({ where: { id: ticket.eventId }, select: { title: true } }) : null;
  return { ticket, replies, eventTitle: event?.title ?? null };
}

export async function getSupportTicketDetailForOrg(organizationId: string, ticketId: string) {
  const ticket = await requireOwnTicketAsOrg(organizationId, ticketId);
  const replies = await prisma.supportTicketReply.findMany({ where: { ticketId: ticket.id }, orderBy: { createdAt: "asc" } });
  const event = ticket.eventId ? await prisma.event.findUnique({ where: { id: ticket.eventId }, select: { title: true } }) : null;
  return { ticket, replies, eventTitle: event?.title ?? null };
}
