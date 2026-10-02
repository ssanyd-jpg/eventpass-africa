import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/notifications";
import { normalizeTanzaniaPhone } from "@/lib/sms";
import { dictionaries, type Locale, type TranslationKey } from "@/lib/i18n";

// Pure message-template lookup, same server-side (no useTranslation/React)
// pattern as buildMemoryMessage in post-event-memory.ts — this runs from a
// cron sweep and the cancellation flow, not a component. No per-user locale
// exists on User/WaitlistEntry today, so every call site defaults to "en",
// same as post-event-memory's own default.
function translate(locale: Locale, key: TranslationKey, vars?: Record<string, string | number>): string {
  const template = dictionaries[locale][key] ?? dictionaries.en[key] ?? key;
  if (!vars) return template;
  return Object.entries(vars).reduce((acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)), template as string);
}

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
  event: { slug: string; title: string; startsAt: Date; waitlistCutoffHours: number };
  ticketType: { name: string };
}) {
  // Session — organiser-configurable cutoff: too close to the event, a
  // fresh "you have 2 hours" offer is unkind, not helpful. Skip without
  // touching status — the entry stays WAITING and either gets picked up
  // again on a future call (once something frees the cutoff, e.g. the
  // organiser raising it) or gets the closure message once the event ends.
  if (isWithinWaitlistCutoff(entry.event)) {
    console.log(
      `[waitlist] skipping notify for entry ${entry.id} — within the ${entry.event.waitlistCutoffHours}h cutoff before "${entry.event.title}" starts`
    );
    return null;
  }

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
      event: { select: { slug: true, title: true, startsAt: true, waitlistCutoffHours: true } },
      ticketType: { select: { name: true } },
    },
  });
  if (!entry) return null;
  return notifyWaitlistEntry(entry);
}

// Pure — drives both the per-send cutoff check above and the organiser
// dashboard's "notifications have stopped" banner without needing a live
// query, same split as shouldShowRevokeBanner in whatsapp-group.ts.
// waitlistCutoffHours <= 0 means "no cutoff", full stop, however close (or
// past) startsAt already is.
export function isWithinWaitlistCutoff(
  event: { startsAt: Date | string; waitlistCutoffHours: number },
  now: Date = new Date()
): boolean {
  if (event.waitlistCutoffHours <= 0) return false;
  const hoursUntilStart = (new Date(event.startsAt).getTime() - now.getTime()) / (60 * 60 * 1000);
  return hoursUntilStart <= event.waitlistCutoffHours;
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
    data: { status: "CONVERTED", convertedAt: new Date() },
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
      data: { status: "EXPIRED", expiredReason: "TIMEOUT" },
    });
    if (res.count === 0) continue;
    const next = await notifyNextWaiting(entry.ticketTypeId);
    if (next) notifiedNext++;
  }

  return { expired: overdue.length, notifiedNext };
}

function buildWaitlistClosureMessage(name: string, eventTitle: string, locale: Locale = "en"): string {
  return [
    translate(locale, "waitlistClosure.greeting", { name }),
    "",
    translate(locale, "waitlistClosure.eventEnded", { event: eventTitle }),
    "",
    translate(locale, "waitlistClosure.browsePrompt"),
    translate(locale, "waitlistClosure.website"),
    "",
    translate(locale, "waitlistClosure.thankYou"),
  ].join("\n");
}

// Compassionate close-out for every still-WAITING entry once an event ends
// or is cancelled — called from the daily cron sweep below (natural end)
// and directly from handleCancelEvent in sync-handlers.ts (immediate,
// cancellation). Idempotent the same way every other status-gated send in
// this file is: the CAS update only ever matches a row still WAITING, so a
// second call (the cron re-checking an event the organiser already
// cancelled, say) finds nothing left to close.
export async function sendWaitlistClosureNotifications(eventId: string): Promise<{ notifiedCount: number }> {
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { title: true } });
  if (!event) return { notifiedCount: 0 };

  const waiting = await prisma.waitlistEntry.findMany({
    where: { eventId, status: "WAITING" },
    select: { id: true, name: true, phone: true },
  });

  let notifiedCount = 0;
  for (const entry of waiting) {
    const res = await prisma.waitlistEntry.updateMany({
      where: { id: entry.id, status: "WAITING" },
      data: { status: "EXPIRED", expiredReason: "EVENT_ENDED" },
    });
    if (res.count === 0) continue;

    await sendNotification({
      type: "WAITLIST_CLOSURE",
      channel: "WHATSAPP",
      recipient: entry.phone,
      subject: `${event.title} waitlist closed`,
      body: buildWaitlistClosureMessage(entry.name, event.title),
    });
    notifiedCount++;
  }
  return { notifiedCount };
}

const CLOSURE_SWEEP_WINDOW_HOURS = 24;

// Cron sweep (rides along on /api/cron/reminders, same Vercel-Hobby
// two-slots-only constraint as the pending top-up/season-renewal/whatsapp
// group archive sweeps already on that route) — catches an event that
// simply ended (not cancelled — handleCancelEvent already closed those
// immediately) while attendees were still WAITING.
export async function runWaitlistClosureSweep(
  now: Date = new Date()
): Promise<{ ok: true; eventsChecked: number; notifiedCount: number }> {
  const windowStart = new Date(now.getTime() - CLOSURE_SWEEP_WINDOW_HOURS * 60 * 60 * 1000);

  const events = await prisma.event.findMany({
    where: {
      waitlistEntries: { some: { status: "WAITING" } },
      OR: [
        { endsAt: { gte: windowStart, lte: now } },
        { endsAt: null, startsAt: { gte: windowStart, lte: now } },
      ],
    },
    select: { id: true },
  });

  let notifiedCount = 0;
  for (const event of events) {
    const { notifiedCount: n } = await sendWaitlistClosureNotifications(event.id);
    notifiedCount += n;
  }
  return { ok: true, eventsChecked: events.length, notifiedCount };
}

export interface WaitlistAnalytics {
  totalJoined: number;
  currentWaiting: number;
  peakSize: number;
  offerSent: number;
  offerAccepted: number;
  offerExpired: number;
  conversionRate: number;
  avgResponseMinutes: number;
  demandByTicketType: Array<{ ticketTypeName: string; count: number }>;
}

// Everything the organiser waitlist dashboard's analytics card needs, read
// once from every WaitlistEntry this event has ever had (there's no
// separate rollup table — fine at pilot scale, same flat-findMany-plus-JS
// style as getWaitlistCounts above and analytics.ts's topEventsByTicketsSold).
export async function getWaitlistAnalytics(eventId: string): Promise<WaitlistAnalytics> {
  const [entries, ticketTypes] = await Promise.all([
    prisma.waitlistEntry.findMany({
      where: { eventId },
      select: { status: true, createdAt: true, notifiedAt: true, convertedAt: true, expiredReason: true, ticketTypeId: true },
    }),
    prisma.ticketType.findMany({ where: { eventId }, select: { id: true, name: true } }),
  ]);

  const totalJoined = entries.length;
  const currentWaiting = entries.filter((e) => e.status === "WAITING").length;
  const offerSent = entries.filter((e) => e.notifiedAt !== null).length;
  const offerAccepted = entries.filter((e) => e.status === "CONVERTED").length;
  const offerExpired = entries.filter((e) => e.status === "EXPIRED" && e.expiredReason !== "EVENT_ENDED").length;
  const conversionRate = offerSent > 0 ? Math.round((offerAccepted / offerSent) * 1000) / 10 : 0;

  // No history table records queue size over time, so this approximates:
  // at the instant each notification went out, the queue held everyone
  // created by then minus everyone already notified (and so already gone)
  // before then. The max of those samples, floored at the current WAITING
  // count (always a real observed size), is the best this model can do.
  let peakSize = currentWaiting;
  for (const sample of entries) {
    if (!sample.notifiedAt) continue;
    const t = sample.notifiedAt.getTime();
    const createdByT = entries.filter((e) => e.createdAt.getTime() <= t).length;
    const notifiedBeforeT = entries.filter((e) => e.notifiedAt && e.notifiedAt.getTime() < t).length;
    peakSize = Math.max(peakSize, createdByT - notifiedBeforeT);
  }

  const responseTimes = entries
    .filter((e) => e.status === "CONVERTED" && e.notifiedAt && e.convertedAt)
    .map((e) => (e.convertedAt!.getTime() - e.notifiedAt!.getTime()) / 60000);
  const avgResponseMinutes =
    responseTimes.length > 0 ? Math.round(responseTimes.reduce((sum, m) => sum + m, 0) / responseTimes.length) : 0;

  const demandCounts = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.ticketTypeId] = (acc[e.ticketTypeId] ?? 0) + 1;
    return acc;
  }, {});
  const demandByTicketType = ticketTypes
    .map((tt) => ({ ticketTypeName: tt.name, count: demandCounts[tt.id] ?? 0 }))
    .sort((a, b) => b.count - a.count);

  return {
    totalJoined,
    currentWaiting,
    peakSize,
    offerSent,
    offerAccepted,
    offerExpired,
    conversionRate,
    avgResponseMinutes,
    demandByTicketType,
  };
}
