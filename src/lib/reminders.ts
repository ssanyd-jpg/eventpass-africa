import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/notifications";
import { formatCents } from "@/lib/format";

// Vercel Cron (see vercel.json) calls sendEventReminders once a day
// (Hobby plan), so an event is reminded if it starts 20h–28h after the run.
// The window is only as wide as one run's reach: with runs 24h apart, a
// window narrower than 24h leaves events starting at some times of day
// never reminded at all. The once-per-attendee guarantee is not the window
// but Ticket.reminderSentAt (stamped after a send, filtered on below) plus
// the NotificationLog check keyed on (type, recipient, subject), which also
// covers reminders sent before that column existed.
const WINDOW_START_HOURS = 20;
const WINDOW_END_HOURS = 28;

export interface SendEventRemindersResult {
  ok: true;
  eventsChecked: number;
  remindersSent: number;
}

// NotificationLog has no eventId column (see its own header comment — it's
// deliberately flat/unscoped), so the event id rides in `subject` instead
// as the idempotency key. This is never shown to the recipient — the
// WhatsApp/SMS text is `body` alone — so it's free to be an internal id.
function reminderLogSubject(eventId: string): string {
  return `Event reminder — ${eventId}`;
}

// A reminder goes to the order's buyer (the distinct-by-userId query below),
// so it stamps every still-unstamped ticket in that buyer's PAID orders for
// the event — not just the first order's.
async function markTicketsReminded(eventId: string, userId: string, at: Date) {
  await prisma.ticket.updateMany({
    where: { eventId, reminderSentAt: null, order: { userId, status: "PAID" } },
    data: { reminderSentAt: at },
  });
}

export async function sendEventReminders(now: Date = new Date()): Promise<SendEventRemindersResult> {
  const windowStart = new Date(now.getTime() + WINDOW_START_HOURS * 60 * 60 * 1000);
  const windowEnd = new Date(now.getTime() + WINDOW_END_HOURS * 60 * 60 * 1000);

  const events = await prisma.event.findMany({
    where: { status: "LIVE", startsAt: { gte: windowStart, lt: windowEnd } },
    select: { id: true, title: true, startsAt: true },
  });

  let remindersSent = 0;

  for (const event of events) {
    const subject = reminderLogSubject(event.id);
    const gatesOpenAt = event.startsAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

    // One row per buyer, same "unique ticket holder" dedup as the
    // EVENT_CANCELLED broadcast above (handleCancelEvent).
    const orders = await prisma.order.findMany({
      where: { eventId: event.id, status: "PAID", tickets: { some: { reminderSentAt: null } } },
      include: { user: { select: { id: true, phone: true } } },
      distinct: ["userId"],
    });

    for (const order of orders) {
      const { user } = order;
      if (!user.phone) continue;

      const alreadySent = await prisma.notificationLog.findFirst({
        where: { type: "EVENT_REMINDER", recipient: user.phone, subject },
      });
      if (alreadySent) {
        // Reminded before Ticket.reminderSentAt existed — backfill it (from
        // when the log row was written) so later runs skip this buyer at the
        // query instead of re-checking the log.
        await markTicketsReminded(event.id, user.id, alreadySent.createdAt);
        continue;
      }

      const wallet = await prisma.wallet.findUnique({
        where: { eventId_ownerUserId: { eventId: event.id, ownerUserId: user.id } },
        select: { balanceCents: true, currency: true },
      });
      const balanceLine = wallet ? formatCents(wallet.balanceCents, wallet.currency) : formatCents(0);

      const log = await sendNotification({
        type: "EVENT_REMINDER",
        channel: "WHATSAPP",
        recipient: user.phone,
        subject,
        body: `📅 Reminder: ${event.title} is tomorrow! Your balance: ${balanceLine}. Gates open at ${gatesOpenAt}.`,
      });
      // A FAILED send is not a sent reminder, so it leaves the tickets
      // unstamped. (A FAILED NotificationLog row still blocks a retry via the
      // check above — unchanged behaviour.) LOGGED means no provider is
      // configured, which the rest of the codebase treats as sent.
      if (log.status !== "FAILED") await markTicketsReminded(event.id, user.id, new Date());
      remindersSent++;
    }
  }

  return { ok: true, eventsChecked: events.length, remindersSent };
}
