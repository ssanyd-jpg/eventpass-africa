import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/notifications";
import { dictionaries, type Locale, type TranslationKey } from "@/lib/i18n";

// Pre-event nudge for a ticket holder who hasn't topped up their Chaap
// wallet yet — rides on the same daily /api/cron/reminders slot as
// sendEventReminders/runPendingTopupSweep/etc. (see that route's own
// comments on why: Vercel Hobby only has two cron slots and both are taken).
//
// There's no Event.cashlessEnabled (or equivalent) flag in the schema —
// every LIVE event already supports wallets unconditionally (Wallet has no
// opt-in gate on Event; EventDetailClient's "Get a cashless wallet for this
// event" link is unconditional too), so this sweep doesn't filter events by
// any such flag, just by the time window.
function translate(locale: Locale, key: TranslationKey, vars?: Record<string, string | number>): string {
  const template = dictionaries[locale][key] ?? dictionaries.en[key] ?? key;
  if (!vars) return template;
  return Object.entries(vars).reduce((acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)), template as string);
}

const WINDOW_START_HOURS = 24;
const WINDOW_END_HOURS = 48;

function reminderSubject(eventId: string, userId: string): string {
  return `Wallet top-up reminder — ${eventId}:${userId}`;
}

export interface WalletTopupReminderSweepResult {
  ok: true;
  eventsChecked: number;
  remindersSent: number;
  skipped: number;
}

// One reminder per (event, buyer), not per ticket: Wallet is unique per
// (eventId, ownerUserId) — see Wallet's own @@unique — so a buyer holding
// several tickets for the same event (a group/family order) still has
// exactly one wallet to top up, and sending them the same nudge once per
// ticket row would just be spam about the same wallet.
export async function runWalletTopupReminderSweep(now: Date = new Date()): Promise<WalletTopupReminderSweepResult> {
  const windowStart = new Date(now.getTime() + WINDOW_START_HOURS * 60 * 60 * 1000);
  const windowEnd = new Date(now.getTime() + WINDOW_END_HOURS * 60 * 60 * 1000);

  const events = await prisma.event.findMany({
    where: { status: "LIVE", startsAt: { gte: windowStart, lt: windowEnd } },
    select: { id: true, title: true },
  });

  let remindersSent = 0;
  let skipped = 0;

  for (const event of events) {
    const orders = await prisma.order.findMany({
      where: { eventId: event.id, status: "PAID" },
      include: { user: { select: { id: true, phone: true } } },
      distinct: ["userId"],
    });

    for (const order of orders) {
      try {
        const { user } = order;
        if (!user.phone) {
          skipped++;
          continue;
        }

        const wallet = await prisma.wallet.findUnique({
          where: { eventId_ownerUserId: { eventId: event.id, ownerUserId: user.id } },
          select: { balanceCents: true },
        });
        if (wallet && wallet.balanceCents > 0) {
          skipped++;
          continue;
        }

        const subject = reminderSubject(event.id, user.id);
        const alreadySent = await prisma.notificationLog.findFirst({
          where: { type: "WALLET_TOPUP_REMINDER", subject },
        });
        if (alreadySent) {
          skipped++;
          continue;
        }

        await sendNotification({
          type: "WALLET_TOPUP_REMINDER",
          channel: "WHATSAPP",
          recipient: user.phone,
          subject,
          body: translate("en", "walletTopupReminder.message", {
            event: event.title,
            link: `${process.env.NEXTAUTH_URL ?? ""}/account/wallet`,
          }),
        });
        remindersSent++;
      } catch (err) {
        console.error(`[wallet-topup-reminder] failed for order ${order.id}`, err);
        skipped++;
      }
    }
  }

  return { ok: true, eventsChecked: events.length, remindersSent, skipped };
}
