import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/notifications";

// Extracted from the customer/broadcast dashboard pages for the same reason
// device-handlers.ts/settlement-handlers.ts are separate from theirs:
// testable without HTTP/session plumbing.

async function requireOwnEvent(organizationId: string, eventId: string) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event || event.organizationId !== organizationId) {
    throw new Error("Event not found.");
  }
  return event;
}

export interface BroadcastRecipient {
  id: string;
  email: string;
  name: string;
}

// distinct: ["userId"] is the exact dedupe pattern already proven in
// handleCancelEvent (sync-handlers.ts) — a buyer who purchased more than
// once for this event/ticket type only gets messaged once.
export async function resolveBroadcastAudience(
  organizationId: string,
  eventId: string,
  ticketTypeId?: string | null
): Promise<{ event: { id: string; title: string }; recipients: BroadcastRecipient[] }> {
  const event = await requireOwnEvent(organizationId, eventId);
  const orders = await prisma.order.findMany({
    where: {
      eventId,
      status: { in: ["PAID", "NEEDS_REVIEW"] },
      ...(ticketTypeId ? { items: { some: { ticketTypeId } } } : {}),
    },
    include: { user: { select: { id: true, email: true, name: true } } },
    distinct: ["userId"],
  });
  return { event: { id: event.id, title: event.title }, recipients: orders.map((o) => o.user) };
}

export interface SendBroadcastResult {
  broadcastId: string;
  eventTitle: string;
  recipientCount: number;
}

export async function sendBroadcast(
  organizationId: string,
  eventId: string,
  ticketTypeId: string | null,
  subject: string,
  body: string,
  sentByUserId: string,
  sentByName: string
): Promise<SendBroadcastResult> {
  const { event, recipients } = await resolveBroadcastAudience(organizationId, eventId, ticketTypeId);

  for (const r of recipients) {
    await sendNotification({ type: "ORGANIZER_BROADCAST", channel: "EMAIL", recipient: r.email, subject, body });
  }

  const broadcast = await prisma.broadcast.create({
    data: {
      organizationId,
      eventId,
      ticketTypeId,
      subject,
      body,
      recipientCount: recipients.length,
      sentByUserId,
      sentByName,
    },
  });

  return { broadcastId: broadcast.id, eventTitle: event.title, recipientCount: recipients.length };
}

// Refuses to note someone who's never actually bought from this org — the
// same cross-org guard reasoning as getCustomerDetailData's customer:null.
export async function addCustomerNoteById(
  organizationId: string,
  customerUserId: string,
  authorUserId: string,
  authorName: string,
  body: string
) {
  const myEvents = await prisma.event.findMany({ where: { organizationId }, select: { id: true } });
  const eventIds = myEvents.map((e) => e.id);
  const hasOrder = await prisma.order.findFirst({ where: { eventId: { in: eventIds }, userId: customerUserId } });
  if (!hasOrder) {
    throw new Error("Not a customer of your organization.");
  }
  return prisma.customerNote.create({
    data: { organizationId, customerUserId, authorUserId, authorName, body },
  });
}
