import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/notifications";
import { getActivePaymentProvider } from "@/lib/payments";
import { formatCents, formatDate } from "@/lib/format";

// Season pass auto-renewal — layered on top of the season pass foundation
// in src/lib/season-pass.ts. Same NotificationLog-keyed idempotency
// convention as reminders.ts/post-event-memory-data.ts: NotificationLog has
// no seasonPassHolderId column (it's deliberately flat/unscoped — see
// reminders.ts's own comment on the identical tradeoff), so the holder id
// rides in `subject` as the dedup key instead. Never shown to the
// recipient — the WhatsApp text is `body` alone.

const RENEWAL_WINDOW_DAYS = 30;
const RENEWAL_TOKEN_EXPIRY_DAYS = 7;
const RENEWAL_EXTENSION_MONTHS = 12;

function renewalOfferSubject(holderId: string): string {
  return `Season pass renewal offer — ${holderId}`;
}

function clubNameFor(organization: { displayName: string | null; name: string }): string {
  return organization.displayName ?? organization.name;
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

export interface EligibleRenewalHolder {
  holderId: string;
  seasonPassId: string;
  seasonPassName: string;
  clubName: string;
  holderName: string;
  holderPhone: string;
  price: number;
  currency: string;
  endDate: Date;
}

// autoRenewEnabled SeasonPasses expiring within the next 30 days, with at
// least one holder still ACTIVE (not yet offered a renewal, or already
// resolved one way or another) — flattened to one row per eligible holder,
// since sendRenewalOffer operates per-holder.
export async function getSeasonPassesEligibleForRenewal(now: Date = new Date()): Promise<EligibleRenewalHolder[]> {
  const windowEnd = new Date(now.getTime() + RENEWAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const passes = await prisma.seasonPass.findMany({
    where: {
      autoRenewEnabled: true,
      status: "ACTIVE",
      endDate: { gte: now, lte: windowEnd },
      holders: { some: { renewalStatus: "ACTIVE" } },
    },
    include: {
      organization: { select: { displayName: true, name: true } },
      holders: { where: { renewalStatus: "ACTIVE" } },
    },
  });

  const eligible: EligibleRenewalHolder[] = [];
  for (const pass of passes) {
    const clubName = clubNameFor(pass.organization);
    for (const holder of pass.holders) {
      eligible.push({
        holderId: holder.id,
        seasonPassId: pass.id,
        seasonPassName: pass.name,
        clubName,
        holderName: holder.name,
        holderPhone: holder.phone,
        price: pass.autoRenewPrice ?? pass.price,
        currency: pass.currency,
        endDate: pass.endDate,
      });
    }
  }
  return eligible;
}

// Sends one holder their renewal offer — idempotent via the NotificationLog
// check below, same discipline as runPostEventMemorySweep. Safe to call
// more than once for the same holder (the cron sweep and the organiser's
// manual "Send renewal offers now" button both call it): a holder no longer
// ACTIVE, or one already logged, is skipped rather than re-offered.
export async function sendRenewalOffer(holderId: string, now: Date = new Date()) {
  const holder = await prisma.seasonPassHolder.findUnique({
    where: { id: holderId },
    include: { seasonPass: { include: { organization: { select: { displayName: true, name: true } } } } },
  });
  if (!holder) return { ok: false as const, error: "Season pass holder not found." };
  if (holder.renewalStatus !== "ACTIVE") {
    return { ok: true as const, skipped: true as const, reason: "NOT_ACTIVE" as const };
  }

  const subject = renewalOfferSubject(holderId);
  const alreadySent = await prisma.notificationLog.findFirst({
    where: { type: "SEASON_PASS_RENEWAL_OFFERED", recipient: holder.phone, subject },
  });
  if (alreadySent) {
    return { ok: true as const, skipped: true as const, reason: "ALREADY_OFFERED" as const };
  }

  const renewalToken = crypto.randomBytes(24).toString("hex");
  const price = holder.seasonPass.autoRenewPrice ?? holder.seasonPass.price;
  const clubName = clubNameFor(holder.seasonPass.organization);
  const firstName = (holder.name || "").trim().split(/\s+/)[0] || holder.name;

  await prisma.seasonPassHolder.update({
    where: { id: holderId },
    data: { renewalStatus: "RENEWAL_OFFERED", renewalOfferedAt: now, renewalToken },
  });

  await sendNotification({
    type: "SEASON_PASS_RENEWAL_OFFERED",
    channel: "WHATSAPP",
    recipient: holder.phone,
    subject,
    body:
      `Hi ${firstName}! 🎟\n\n` +
      `Your ${clubName} season pass expires on ${formatDate(holder.seasonPass.endDate)}.\n\n` +
      `Renew now for ${formatCents(price, holder.seasonPass.currency)} and keep your wristband active for the new season:\n` +
      `👉 chaap.africa/renew/${renewalToken}\n\n` +
      `Tap the link to confirm with M-Pesa — takes 30 seconds.\n\n` +
      `This offer expires in 7 days.\n` +
      `— The Chaap team`,
  });

  return { ok: true as const, renewalToken };
}

export interface RenewalOfferStatus {
  clubName: string;
  seasonPassName: string;
  price: number;
  currency: string;
  endDate: string;
  state: "OFFERED" | "EXPIRED" | "ALREADY_RENEWED" | "ALREADY_DECLINED" | "NOT_FOUND";
}

// Backs the public /renew/[token] page's read-only view — never mutates,
// unlike processRenewal/declineRenewal below.
export async function getRenewalOfferStatus(renewalToken: string, now: Date = new Date()): Promise<RenewalOfferStatus | null> {
  const holder = await prisma.seasonPassHolder.findUnique({
    where: { renewalToken },
    include: { seasonPass: { include: { organization: { select: { displayName: true, name: true } } } } },
  });
  if (!holder) return null;

  const clubName = clubNameFor(holder.seasonPass.organization);
  const price = holder.seasonPass.autoRenewPrice ?? holder.seasonPass.price;
  const base = {
    clubName,
    seasonPassName: holder.seasonPass.name,
    price,
    currency: holder.seasonPass.currency,
    endDate: holder.seasonPass.endDate.toISOString(),
  };

  if (holder.renewalStatus === "RENEWAL_CONFIRMED") return { ...base, state: "ALREADY_RENEWED" };
  if (holder.renewalStatus === "RENEWAL_DECLINED") return { ...base, state: "ALREADY_DECLINED" };
  if (holder.renewalStatus !== "RENEWAL_OFFERED" || !holder.renewalOfferedAt) return { ...base, state: "NOT_FOUND" };

  const expiresAt = new Date(holder.renewalOfferedAt.getTime() + RENEWAL_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  if (now > expiresAt) return { ...base, state: "EXPIRED" };
  return { ...base, state: "OFFERED" };
}

export type ProcessRenewalResult =
  | { ok: true; status: "CONFIRMED" }
  | { ok: true; status: "PENDING"; message?: string }
  | { ok: false; error: string };

// Called when the holder taps "Renew now" on /renew/[token]. Mirrors
// purchaseSeasonPass's PAID/PENDING/FAILED handling (see its own comment on
// why PENDING resolves to nothing further here — no AirPay webhook/poll
// route exists for this path either).
export async function processRenewal(
  renewalToken: string,
  input: { phoneNumber: string; mobileNetwork?: string },
  now: Date = new Date()
): Promise<ProcessRenewalResult> {
  const holder = await prisma.seasonPassHolder.findUnique({
    where: { renewalToken },
    include: { seasonPass: { include: { organization: { select: { displayName: true, name: true } } } } },
  });
  if (!holder) return { ok: false, error: "This renewal link is invalid." };
  if (holder.renewalStatus === "RENEWAL_CONFIRMED") {
    return { ok: false, error: "Your season pass is already renewed. See you at the next match! ✅" };
  }
  if (holder.renewalStatus !== "RENEWAL_OFFERED" || !holder.renewalOfferedAt) {
    return { ok: false, error: "This renewal offer is no longer available." };
  }

  const expiresAt = new Date(holder.renewalOfferedAt.getTime() + RENEWAL_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  if (now > expiresAt) {
    return { ok: false, error: "This renewal link has expired. Contact your club to renew manually." };
  }
  if (!input.phoneNumber.trim()) return { ok: false, error: "Enter your mobile money number." };

  const price = holder.seasonPass.autoRenewPrice ?? holder.seasonPass.price;
  const clubName = clubNameFor(holder.seasonPass.organization);

  const charge = await getActivePaymentProvider().initiateCharge({
    orderClientId: `season-renew-${holder.id}-${now.getTime().toString(36)}`,
    amountCents: price,
    phoneNumber: input.phoneNumber,
    mobileNetwork: input.mobileNetwork,
    description: `Season pass renewal — ${holder.seasonPass.name}`,
  });

  if (charge.status === "FAILED") {
    // Reuses the RENEWAL_OFFERED type — same open offer thread, just a
    // failed attempt prompting a retry via the same still-valid link.
    await sendNotification({
      type: "SEASON_PASS_RENEWAL_OFFERED",
      channel: "WHATSAPP",
      recipient: holder.phone,
      subject: `Season pass renewal retry — ${holder.id}`,
      body: `❌ Renewal payment failed. Tap here to try again: chaap.africa/renew/${renewalToken}`,
    });
    return { ok: false, error: charge.message ?? "The payment was declined." };
  }
  if (charge.status === "PENDING") {
    return { ok: true, status: "PENDING", message: charge.message };
  }

  await prisma.seasonPassHolder.update({
    where: { id: holder.id },
    data: { renewalStatus: "RENEWAL_CONFIRMED", renewalConfirmedAt: now },
  });
  // Extends the whole SeasonPass's shared endDate, not a per-holder date —
  // there is no per-holder expiry in this schema (see SeasonPassHolder's
  // own comment), matching the spec's literal "extends SeasonPass.endDate
  // by one season" instruction as written. One holder renewing therefore
  // pushes every holder's access out by a season too — a real product
  // quirk worth organiser awareness, not an oversight.
  await prisma.seasonPass.update({
    where: { id: holder.seasonPassId },
    data: { endDate: addMonths(holder.seasonPass.endDate, RENEWAL_EXTENSION_MONTHS) },
  });

  await sendNotification({
    type: "SEASON_PASS_RENEWED",
    channel: "WHATSAPP",
    recipient: holder.phone,
    subject: `Season pass renewed — ${holder.id}`,
    body: `✅ Your ${clubName} season pass has been renewed! Your wristband stays active. See you at the next match.`,
  });

  return { ok: true, status: "CONFIRMED" };
}

// Called when the holder taps "No thanks" on /renew/[token].
export async function declineRenewal(renewalToken: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const holder = await prisma.seasonPassHolder.findUnique({
    where: { renewalToken },
    include: { seasonPass: { select: { endDate: true } } },
  });
  if (!holder) return { ok: false, error: "This renewal link is invalid." };
  if (holder.renewalStatus !== "RENEWAL_OFFERED") {
    return { ok: false, error: "This renewal offer is no longer available." };
  }

  await prisma.seasonPassHolder.update({
    where: { id: holder.id },
    data: { renewalStatus: "RENEWAL_DECLINED" },
  });

  await sendNotification({
    type: "SEASON_PASS_RENEWAL_DECLINED",
    channel: "WHATSAPP",
    recipient: holder.phone,
    subject: `Season pass renewal declined — ${holder.id}`,
    body: `Understood — your pass expires on ${formatDate(holder.seasonPass.endDate)}. You can always renew manually at chaap.africa.`,
  });

  return { ok: true };
}

export interface SeasonRenewalSweepResult {
  offersSent: number;
  skipped: number;
}

// Wired into /api/cron/reminders/route.ts, same "rides along on the one
// daily cron slot" discipline as runPendingTopupSweep.
export async function runSeasonRenewalSweep(now: Date = new Date()): Promise<SeasonRenewalSweepResult> {
  const eligible = await getSeasonPassesEligibleForRenewal(now);
  let offersSent = 0;
  let skipped = 0;
  for (const holder of eligible) {
    try {
      const result = await sendRenewalOffer(holder.holderId, now);
      if (result.ok && !("skipped" in result)) offersSent++;
      else skipped++;
    } catch (err) {
      console.error(`[season-renewal] offer failed for holder ${holder.holderId}`, err);
      skipped++;
    }
  }
  return { offersSent, skipped };
}
