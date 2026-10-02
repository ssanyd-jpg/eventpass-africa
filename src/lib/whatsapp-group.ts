import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/notifications";
import { formatDate } from "@/lib/format";
import { eventHasEnded } from "@/lib/carry-over";

// Africa's Talking's WhatsApp API has no group-creation endpoint (see
// src/lib/whatsapp.ts and src/types/africastalking.d.ts — sendMessage is
// the entire surface) — WhatsApp groups can only be created by a human,
// on their own phone. Chaap's role here is entirely downstream of that:
// the organiser creates the group and pastes its invite link onto the
// event (Event.whatsappGroupLink); this module only ever relays that link
// to opted-in attendees and, after the event, tells them it's archived.

function currentHolder(ticket: { currentHolderUserId: string | null; order: { userId: string } }) {
  return ticket.currentHolderUserId ?? ticket.order.userId;
}

const ticketWithEventInclude = {
  event: {
    select: {
      id: true,
      title: true,
      startsAt: true,
      whatsappGroupEnabled: true,
      whatsappGroupLink: true,
    },
  },
  order: { select: { userId: true } },
} as const;

export type SendGroupInviteReason =
  | "ALREADY_SENT"
  | "GROUP_NOT_CONFIGURED"
  | "NO_PHONE"
  | "TICKET_NOT_FOUND";

export interface SendGroupInviteResult {
  sent: boolean;
  reason?: SendGroupInviteReason;
}

// Idempotent — a ticket with whatsappGroupInviteSentAt already set is never
// sent to twice, whatever calls this (order-completion, the organiser's
// "Send invites now" batch, or an attendee's own "Join" button). Always
// stamps whatsappGroupOptedIn true on a successful send, since receiving
// the invite link *is* the opt-in for a ticket that got here some other
// way (e.g. a transferred ticket's new holder clicking "Join").
export async function sendGroupInvite(ticketId: string): Promise<SendGroupInviteResult> {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId }, include: ticketWithEventInclude });
  if (!ticket) return { sent: false, reason: "TICKET_NOT_FOUND" };
  if (ticket.whatsappGroupInviteSentAt) return { sent: false, reason: "ALREADY_SENT" };
  if (!ticket.event.whatsappGroupEnabled || !ticket.event.whatsappGroupLink) {
    return { sent: false, reason: "GROUP_NOT_CONFIGURED" };
  }

  const holder = await prisma.user.findUnique({
    where: { id: currentHolder(ticket) },
    select: { name: true, phone: true },
  });
  if (!holder?.phone) return { sent: false, reason: "NO_PHONE" };

  await sendNotification({
    type: "WHATSAPP_GROUP_INVITE_SENT",
    channel: "WHATSAPP",
    recipient: holder.phone,
    subject: "WhatsApp group invite",
    body: `Hi ${holder.name}! 👋\n\nYou're going to ${ticket.event.title} on ${formatDate(ticket.event.startsAt)} — join the official WhatsApp group to connect with other attendees and get updates from the organiser:\n\n👉 ${ticket.event.whatsappGroupLink}\n\nSee you there! — The Chaap team`,
  });

  await prisma.ticket.update({
    where: { id: ticket.id },
    data: { whatsappGroupOptedIn: true, whatsappGroupInviteSentAt: new Date() },
  });
  return { sent: true };
}

// Organiser's "Send invites now" catch-up — covers any opted-in ticket
// sendGroupInvite hasn't reached yet (e.g. the organiser only pasted the
// group link after some tickets had already sold).
export async function sendPendingGroupInvites(eventId: string): Promise<{ sentCount: number }> {
  const tickets = await prisma.ticket.findMany({
    where: { eventId, whatsappGroupOptedIn: true, whatsappGroupInviteSentAt: null, order: { status: "PAID" } },
    select: { id: true },
  });

  let sentCount = 0;
  for (const ticket of tickets) {
    const result = await sendGroupInvite(ticket.id);
    if (result.sent) sentCount++;
  }
  return { sentCount };
}

export interface TicketGroupState {
  groupEnabled: boolean;
  groupLink: string | null;
  optedIn: boolean;
  inviteSentAt: string | null;
}

// The account ticket page's data — only for the ticket's current holder
// (null for anyone else), same ownership discipline as getTicketResaleState.
// Dates come back as ISO strings for the same reason TicketResaleState's
// do — this crosses straight into a Client Component prop.
export async function getTicketGroupState(userId: string, ticketId: string): Promise<TicketGroupState | null> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: {
      order: { select: { userId: true } },
      event: { select: { whatsappGroupEnabled: true, whatsappGroupLink: true } },
    },
  });
  if (!ticket || currentHolder(ticket) !== userId) return null;

  return {
    groupEnabled: ticket.event.whatsappGroupEnabled,
    groupLink: ticket.event.whatsappGroupLink,
    optedIn: ticket.whatsappGroupOptedIn,
    inviteSentAt: ticket.whatsappGroupInviteSentAt ? ticket.whatsappGroupInviteSentAt.toISOString() : null,
  };
}

// Lets an attendee who never saw the order-confirmation toggle (a
// transferred ticket's new holder, or a group-checkout member) opt in or
// out from their own ticket page. Ownership-checked the same way
// resale.ts/ticket-transfer.ts gate their own per-ticket actions.
export async function setTicketGroupOptIn(userId: string, ticketId: string, optedIn: boolean): Promise<void> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: { order: { select: { userId: true } } },
  });
  if (!ticket || currentHolder(ticket) !== userId) {
    throw new Error("Forbidden");
  }
  await prisma.ticket.update({ where: { id: ticketId }, data: { whatsappGroupOptedIn: optedIn } });
}

export async function joinGroup(userId: string, ticketId: string): Promise<SendGroupInviteResult> {
  await setTicketGroupOptIn(userId, ticketId, true);
  return sendGroupInvite(ticketId);
}

export async function leaveGroup(userId: string, ticketId: string): Promise<void> {
  await setTicketGroupOptIn(userId, ticketId, false);
}

export interface GroupOptInStats {
  optedInCount: number;
  invitesSentCount: number;
  archivedAt: Date | null;
}

export async function getGroupOptInStats(eventId: string): Promise<GroupOptInStats> {
  const [optedInCount, invitesSentCount, event] = await Promise.all([
    prisma.ticket.count({ where: { eventId, whatsappGroupOptedIn: true, order: { status: "PAID" } } }),
    prisma.ticket.count({ where: { eventId, whatsappGroupInviteSentAt: { not: null }, order: { status: "PAID" } } }),
    prisma.event.findUnique({ where: { id: eventId }, select: { whatsappGroupArchivedAt: true } }),
  ]);
  return { optedInCount, invitesSentCount, archivedAt: event?.whatsappGroupArchivedAt ?? null };
}

// Idempotent (whatsappGroupArchivedAt gates it) and only fires once the
// event has actually ended — status CANCELLED counts as ended too, same
// "never going to happen now" treatment waitlist/reminders give a
// cancelled event.
export async function sendGroupArchiveMessage(
  eventId: string,
  now: Date = new Date()
): Promise<{ sent: boolean; notifiedCount: number }> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, title: true, startsAt: true, endsAt: true, status: true, whatsappGroupArchivedAt: true },
  });
  if (!event || event.whatsappGroupArchivedAt) return { sent: false, notifiedCount: 0 };

  const ended = event.status === "CANCELLED" || eventHasEnded({ startsAt: event.startsAt, endsAt: event.endsAt }, now);
  if (!ended) return { sent: false, notifiedCount: 0 };

  const tickets = await prisma.ticket.findMany({
    where: { eventId, whatsappGroupOptedIn: true, order: { status: "PAID" } },
    select: { currentHolderUserId: true, order: { select: { userId: true } } },
  });
  const holderIds = Array.from(new Set(tickets.map((t) => t.currentHolderUserId ?? t.order.userId)));

  let notifiedCount = 0;
  for (const holderId of holderIds) {
    const holder = await prisma.user.findUnique({ where: { id: holderId }, select: { name: true, phone: true } });
    if (!holder?.phone) continue;
    await sendNotification({
      type: "WHATSAPP_GROUP_ARCHIVED",
      channel: "WHATSAPP",
      recipient: holder.phone,
      subject: "WhatsApp group archived",
      body: `🎉 ${event.title} is a wrap — thank you for being part of it!\n\nThe official WhatsApp group is now archived. We hope to see you at the next one.\n\nYour event recap is on its way shortly.\n\n— The Chaap team 🌍 chaap.africa`,
    });
    notifiedCount++;
  }

  // Set regardless of notifiedCount — an event with zero opted-in holders
  // still counts as archived, same "idempotency gate fires once, not once
  // per successful notification" discipline as Event.whatsappGroupArchivedAt's
  // own doc comment.
  await prisma.event.update({ where: { id: eventId }, data: { whatsappGroupArchivedAt: now } });
  return { sent: true, notifiedCount };
}

const ARCHIVE_SWEEP_WINDOW_HOURS = 24;

// Cron sweep (rides along on /api/cron/reminders, same Vercel-Hobby
// two-slots-only constraint as the pending top-up/season-renewal sweeps on
// that route) — catches an event 24h after it ends without requiring the
// organiser to remember to click "Send archive message" themselves.
export async function runWhatsappGroupArchiveSweep(
  now: Date = new Date()
): Promise<{ ok: true; eventsChecked: number; archivedCount: number }> {
  const windowStart = new Date(now.getTime() - ARCHIVE_SWEEP_WINDOW_HOURS * 60 * 60 * 1000);

  const events = await prisma.event.findMany({
    where: {
      whatsappGroupEnabled: true,
      whatsappGroupLink: { not: null },
      whatsappGroupArchivedAt: null,
      OR: [
        { endsAt: { gte: windowStart, lte: now } },
        { endsAt: null, startsAt: { gte: windowStart, lte: now } },
      ],
    },
    select: { id: true },
  });

  let archivedCount = 0;
  for (const event of events) {
    const result = await sendGroupArchiveMessage(event.id, now);
    if (result.sent) archivedCount++;
  }

  return { ok: true, eventsChecked: events.length, archivedCount };
}

// Pure — drives both the dashboard's dismissible "revoke your invite link"
// banner and its test coverage without needing a live event row.
export function shouldShowRevokeBanner(
  event: {
    whatsappGroupEnabled: boolean;
    startsAt: Date | string;
    endsAt?: Date | string | null;
    whatsappGroupLinkRevokedAt?: Date | string | null;
  },
  now: Date = new Date()
): boolean {
  if (!event.whatsappGroupEnabled || event.whatsappGroupLinkRevokedAt) return false;
  const end = new Date(event.endsAt ?? event.startsAt);
  const hoursSinceEnd = (now.getTime() - end.getTime()) / (60 * 60 * 1000);
  return hoursSinceEnd >= 24;
}
