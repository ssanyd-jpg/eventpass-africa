import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/notifications";
import { buildMemoryMessage } from "@/lib/post-event-memory";
import type { Locale } from "@/lib/i18n";

// NotificationLog has no eventId column (deliberately flat/unscoped — see
// reminders.ts's own comment on the same tradeoff), so the event id rides
// in `subject` as the idempotency key, same convention as
// reminderLogSubject. Never shown to the recipient — the WhatsApp text is
// `body` alone.
function memoryLogSubject(eventId: string): string {
  return `Post-event memory — ${eventId}`;
}

export interface EventAttendee {
  userId: string;
  name: string;
  phone: string | null;
  checkInTime: Date | null;
  totalSpentCents: number;
  vendorCount: number;
  ticketIds: string[];
}

// One row per buyer with at least one checked-in, PAID ticket for this
// event — queried at the Ticket level (not distinct-by-order like
// reminders.ts) so a buyer with more than one order still gets every
// checked-in ticket's check-in time and none of their spend is missed.
export async function getEventAttendees(eventId: string): Promise<EventAttendee[]> {
  const tickets = await prisma.ticket.findMany({
    where: { eventId, checkedIn: true, order: { status: "PAID" } },
    select: {
      id: true,
      checkedInAt: true,
      order: { select: { user: { select: { id: true, name: true, phone: true } } } },
    },
  });

  const byUser = new Map<string, EventAttendee>();
  for (const ticket of tickets) {
    const { user } = ticket.order;
    let attendee = byUser.get(user.id);
    if (!attendee) {
      attendee = {
        userId: user.id,
        name: user.name,
        phone: user.phone,
        checkInTime: null,
        totalSpentCents: 0,
        vendorCount: 0,
        ticketIds: [],
      };
      byUser.set(user.id, attendee);
    }
    attendee.ticketIds.push(ticket.id);
    if (ticket.checkedInAt && (!attendee.checkInTime || ticket.checkedInAt < attendee.checkInTime)) {
      attendee.checkInTime = ticket.checkedInAt;
    }
  }

  // Wallet spend — one wallet per (eventId, ownerUserId) (see Wallet's
  // @@unique), summed from COMPLETED SALE rows the same way handleSellTickets'
  // sibling charge handlers write them (positive amountCents, vendorId set).
  for (const attendee of Array.from(byUser.values())) {
    const wallet = await prisma.wallet.findUnique({
      where: { eventId_ownerUserId: { eventId, ownerUserId: attendee.userId } },
      select: { id: true },
    });
    if (!wallet) continue;

    const sales = await prisma.walletTransaction.findMany({
      where: { walletId: wallet.id, type: "SALE", status: "COMPLETED" },
      select: { amountCents: true, vendorId: true },
    });
    attendee.totalSpentCents = sales.reduce((sum, s) => sum + (s.amountCents ?? 0), 0);
    attendee.vendorCount = new Set(sales.map((s) => s.vendorId).filter((v): v is string => !!v)).size;
  }

  return Array.from(byUser.values());
}

function formatFinishTime(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

// MARATHON-only — the finish gun time at the event's isFinish TimingPoint,
// formatted "Xh Ym Zs" (see leaderboard.ts/timing.ts for the same
// gunTimeOffsetSeconds data, formatted differently there for the
// HH:MM:SS results table). null when there's no finish point, no tap
// recorded for this credential, or the race hadn't started when it tapped.
export async function getAttendeeFinishTime(credentialId: string, eventId: string): Promise<string | null> {
  const finishPoint = await prisma.timingPoint.findFirst({
    where: { eventId, isFinish: true },
    select: { id: true },
  });
  if (!finishPoint) return null;

  const chipTime = await prisma.chipTime.findFirst({
    where: { eventId, credentialId, timingPointId: finishPoint.id },
    select: { gunTimeOffsetSeconds: true },
  });
  if (!chipTime || chipTime.gunTimeOffsetSeconds == null) return null;

  return formatFinishTime(chipTime.gunTimeOffsetSeconds);
}

export interface PostEventMemoryStatus {
  eventTitle: string;
  eligible: boolean;
  alreadySent: boolean;
  eligibleAttendeeCount: number;
}

// Backs the organiser dashboard button's visibility/idempotent-label logic
// (GET /api/dashboard/events/[id]/post-event-memory). "Eligible" mirrors
// carry-over's own eventHasEnded reasoning (endsAt ?? treat startsAt-passed
// separately isn't needed here — CANCELLED is its own explicit eligibility
// path per the spec) plus "at least one checked-in attendee has a phone".
export async function getPostEventMemoryStatus(eventId: string): Promise<PostEventMemoryStatus | null> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, title: true, endsAt: true, status: true },
  });
  if (!event) return null;

  const hasEnded = event.status === "CANCELLED" || (event.endsAt != null && event.endsAt.getTime() <= Date.now());
  const attendees = await getEventAttendees(eventId);
  const eligibleAttendeeCount = attendees.filter((a) => !!a.phone).length;

  const existing = await prisma.notificationLog.findFirst({
    where: { type: "POST_EVENT_MEMORY", subject: memoryLogSubject(eventId) },
    select: { id: true },
  });

  return {
    eventTitle: event.title,
    eligible: hasEnded && eligibleAttendeeCount > 0,
    alreadySent: !!existing,
    eligibleAttendeeCount,
  };
}

export interface PostEventMemorySweepResult {
  ok: true;
  notifiedCount: number;
  skippedCount: number;
}

// Loops every checked-in attendee with a phone on file, builds their recap,
// and sends it via WhatsApp (falling back to SMS/log, same as every other
// notification — see sendNotification). Idempotent per (event, phone) via
// the NotificationLog check below; a single attendee's send failing never
// stops the rest of the sweep.
export async function runPostEventMemorySweep(eventId: string, locale: Locale = "en"): Promise<PostEventMemorySweepResult> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, title: true, eventType: true, currency: true },
  });
  if (!event) return { ok: true, notifiedCount: 0, skippedCount: 0 };

  const subject = memoryLogSubject(eventId);
  const attendees = await getEventAttendees(eventId);

  let notifiedCount = 0;
  let skippedCount = 0;

  for (const attendee of attendees) {
    if (!attendee.phone) {
      skippedCount++;
      continue;
    }

    const alreadyNotified = await prisma.notificationLog.findFirst({
      where: { type: "POST_EVENT_MEMORY", recipient: attendee.phone, subject },
    });
    if (alreadyNotified) {
      skippedCount++;
      continue;
    }

    try {
      let finishTime: string | null = null;
      if (event.eventType === "MARATHON" && attendee.ticketIds.length > 0) {
        const credential = await prisma.credential.findFirst({
          where: { ticketId: { in: attendee.ticketIds }, status: "ACTIVE" },
          select: { id: true },
        });
        if (credential) {
          finishTime = await getAttendeeFinishTime(credential.id, eventId);
        }
      }

      const message = buildMemoryMessage({
        attendee: { name: attendee.name },
        event: { title: event.title },
        checkInTime: attendee.checkInTime,
        totalSpentCents: attendee.totalSpentCents,
        vendorCount: attendee.vendorCount,
        finishTime,
        currency: event.currency,
        locale,
      });

      await sendNotification({
        type: "POST_EVENT_MEMORY",
        channel: "WHATSAPP",
        recipient: attendee.phone,
        subject,
        body: message,
      });
      notifiedCount++;
    } catch (err) {
      console.error(`[post-event-memory] send failed for attendee ${attendee.userId} at event ${eventId}`, err);
      skippedCount++;
    }
  }

  return { ok: true, notifiedCount, skippedCount };
}
