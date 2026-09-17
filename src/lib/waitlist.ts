import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/notifications";
import { normalizeTanzaniaPhone } from "@/lib/sms";

// Vercel Cron (src/app/api/cron/waitlist/route.ts) runs every 30 minutes and
// expires any NOTIFIED entry whose window has closed — see
// expireStaleWaitlistNotifications below.
export const WAITLIST_NOTIFICATION_WINDOW_HOURS = 2;

export interface JoinWaitlistInput {
  eventId: string;
  ticketTypeId: string;
  userId?: string | null;
  name: string;
  phone: string;
  email?: string | null;
}

// position is a plain running count within (eventId, ticketTypeId), assigned
// once and never renumbered — see the model's own schema comment for why
// that's the right shape for a stable "you are #N" display.
export async function joinWaitlist(input: JoinWaitlistInput) {
  const position =
    (await prisma.waitlistEntry.count({
      where: { eventId: input.eventId, ticketTypeId: input.ticketTypeId },
    })) + 1;

  return prisma.waitlistEntry.create({
    data: {
      eventId: input.eventId,
      ticketTypeId: input.ticketTypeId,
      userId: input.userId ?? null,
      name: input.name,
      phone: normalizeTanzaniaPhone(input.phone),
      email: input.email ?? null,
      position,
    },
  });
}

export async function getWaitlistEntry(entryId: string) {
  return prisma.waitlistEntry.findUnique({
    where: { id: entryId },
    include: {
      event: { select: { slug: true, title: true } },
      ticketType: { select: { name: true } },
    },
  });
}

// Forfeiting a NOTIFIED spot must not leave it stranded — release it to
// whoever's next in line, same as an unmet 2h deadline would.
export async function leaveWaitlist(entryId: string) {
  const entry = await prisma.waitlistEntry.findUnique({ where: { id: entryId } });
  if (!entry) return null;

  await prisma.waitlistEntry.delete({ where: { id: entryId } });
  if (entry.status === "NOTIFIED") {
    await notifyNextWaiting(entry.ticketTypeId);
  }
  return entry;
}

export interface WaitlistCount {
  ticketTypeId: string;
  ticketTypeName: string;
  waiting: number;
}

// Flat findMany + JS reduce, not a Prisma groupBy — matches the aggregation
// style already established in analytics.ts's topEventsByTicketsSold.
export async function getWaitlistCounts(eventId: string): Promise<WaitlistCount[]> {
  const ticketTypes = await prisma.ticketType.findMany({
    where: { eventId },
    select: { id: true, name: true },
  });
  const waiting = await prisma.waitlistEntry.findMany({
    where: { eventId, status: "WAITING" },
    select: { ticketTypeId: true },
  });
  const counts = waiting.reduce<Record<string, number>>((acc, w) => {
    acc[w.ticketTypeId] = (acc[w.ticketTypeId] ?? 0) + 1;
    return acc;
  }, {});
  return ticketTypes.map((tt) => ({
    ticketTypeId: tt.id,
    ticketTypeName: tt.name,
    waiting: counts[tt.id] ?? 0,
  }));
}

// Sends the WhatsApp notification (falls back to SMS — see whatsapp.ts) and
// flips WAITING -> NOTIFIED. Never called on anything but a WAITING row (the
// only two call sites, notifyNextWaiting and the cron's cascade, both
// resolve one via a status="WAITING" findFirst first).
async function notifyWaitlistEntry(entry: {
  id: string;
  phone: string;
  event: { slug: string; title: string };
  ticketType: { name: string };
}) {
  const purchaseUrl = `${process.env.NEXTAUTH_URL ?? ""}/waitlist/${entry.id}`;
  await sendNotification({
    type: "WAITLIST_SPOT_AVAILABLE",
    channel: "WHATSAPP",
    recipient: entry.phone,
    subject: `Waitlist spot available — ${entry.id}`,
    body: `🎟 Good news! A ${entry.ticketType.name} ticket for ${entry.event.title} is now available. You have 2 hours to complete your purchase: ${purchaseUrl}. After 2 hours your spot goes to the next person on the list.`,
  });
  return prisma.waitlistEntry.update({
    where: { id: entry.id },
    data: { status: "NOTIFIED", notifiedAt: new Date() },
  });
}

// The one "who's next" query the whole feature runs — lowest position among
// still-WAITING entries for this ticket type.
export async function notifyNextWaiting(ticketTypeId: string) {
  const entry = await prisma.waitlistEntry.findFirst({
    where: { ticketTypeId, status: "WAITING" },
    orderBy: { position: "asc" },
    include: {
      event: { select: { slug: true, title: true } },
      ticketType: { select: { name: true } },
    },
  });
  if (!entry) return null;
  return notifyWaitlistEntry(entry);
}

// Organiser manual trigger ("Notify next X on waitlist") — no
// waitlistEnabled gate, since the organiser is already on this event's
// waitlist management page and explicitly asked for it.
export async function notifyNextInWaitlist(ticketTypeId: string, count: number) {
  const notified = [];
  for (let i = 0; i < count; i++) {
    const entry = await notifyNextWaiting(ticketTypeId);
    if (!entry) break;
    notified.push(entry);
  }
  return notified;
}

// Automatic trigger — called after inventory is actually freed (a
// cancellation/refund releasing `quantityFreed` tickets, or an organiser
// increasing quantityTotal by that much). Gated on waitlistEnabled since,
// unlike the manual trigger above, this fires unconditionally from
// sync-handlers.ts on every such event regardless of whether this event
// uses waitlists at all.
export async function releaseWaitlistCapacity(ticketTypeId: string, quantityFreed: number) {
  if (quantityFreed <= 0) return [];
  const ticketType = await prisma.ticketType.findUnique({
    where: { id: ticketTypeId },
    include: { event: { select: { waitlistEnabled: true } } },
  });
  if (!ticketType || !ticketType.event.waitlistEnabled) return [];
  return notifyNextInWaitlist(ticketTypeId, quantityFreed);
}

export async function convertWaitlistEntry(entryId: string) {
  const res = await prisma.waitlistEntry.updateMany({
    where: { id: entryId, status: "NOTIFIED" },
    data: { status: "CONVERTED" },
  });
  return res.count > 0;
}

export interface ExpireWaitlistResult {
  expired: number;
  notifiedNext: number;
}

// Vercel Cron (see vercel.json), every 30 minutes. A NOTIFIED entry whose
// window closed without converting is expired, then immediately cascades to
// notify the next WAITING entry for that same ticket type — the spot never
// sits idle waiting for the next cron tick.
export async function expireStaleWaitlistNotifications(now: Date = new Date()): Promise<ExpireWaitlistResult> {
  const cutoff = new Date(now.getTime() - WAITLIST_NOTIFICATION_WINDOW_HOURS * 60 * 60 * 1000);
  const overdue = await prisma.waitlistEntry.findMany({
    where: { status: "NOTIFIED", notifiedAt: { lte: cutoff } },
  });

  let notifiedNext = 0;
  for (const entry of overdue) {
    // CAS — same "don't clobber a state that already moved on" discipline
    // every status transition in sync-handlers.ts uses, in case something
    // else (e.g. leaveWaitlist) resolved this entry between the findMany
    // above and this update.
    const res = await prisma.waitlistEntry.updateMany({
      where: { id: entry.id, status: "NOTIFIED" },
      data: { status: "EXPIRED" },
    });
    if (res.count === 0) continue;
    const next = await notifyNextWaiting(entry.ticketTypeId);
    if (next) notifiedNext++;
  }

  return { expired: overdue.length, notifiedNext };
}
