import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/notifications";
import { formatCents } from "@/lib/format";

// Vercel Cron (see vercel.json) calls sendEventReminders roughly hourly —
// a 2-hour lookahead window (23h–25h) rather than an exact 24h point means
// an event still gets caught even if a run is a little late or one run is
// missed. That makes the window itself an approximation; the real
// once-per-attendee guarantee is the NotificationLog check below, keyed on
// (type, recipient, subject), which is what actually prevents a duplicate
// reminder if the same event falls inside two consecutive runs' windows.
const WINDOW_START_HOURS = 23;
const WINDOW_END_HOURS = 25;

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
      where: { eventId: event.id, status: "PAID" },
      include: { user: { select: { id: true, phone: true } } },
      distinct: ["userId"],
    });

    for (const order of orders) {
      const { user } = order;
      if (!user.phone) continue;

      const alreadySent = await prisma.notificationLog.findFirst({
        where: { type: "EVENT_REMINDER", recipient: user.phone, subject },
      });
      if (alreadySent) continue;

      const wallet = await prisma.wallet.findUnique({
        where: { eventId_ownerUserId: { eventId: event.id, ownerUserId: user.id } },
        select: { balanceCents: true, currency: true },
      });
      const balanceLine = wallet ? formatCents(wallet.balanceCents, wallet.currency) : formatCents(0);

      await sendNotification({
        type: "EVENT_REMINDER",
        channel: "WHATSAPP",
        recipient: user.phone,
        subject,
        body: `📅 Reminder: ${event.title} is tomorrow! Your balance: ${balanceLine}. Gates open at ${gatesOpenAt}.`,
      });
      remindersSent++;
    }
  }

  return { ok: true, eventsChecked: events.length, remindersSent };
}
