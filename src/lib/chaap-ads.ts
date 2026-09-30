import { prisma } from "@/lib/prisma";
import { getActivePaymentProvider } from "@/lib/payments";
import { sendNotification } from "@/lib/notifications";
import { DEFAULT_CURRENCY } from "@/lib/currency";

// Chaap Ads marketplace — a second, between-events revenue stream for the
// /events public marketplace (schema: FeaturedListing/AdBroadcast in
// prisma/schema.prisma). Two paid products, both charged to the ORGANISER
// (not a buyer) via the same getActivePaymentProvider().initiateCharge()
// checkout shape purchaseSeasonPass already uses (src/lib/season-pass.ts) —
// same reserve-then-charge posture, same "PENDING creates nothing yet, no
// webhook to resolve it later" limitation.

export type FeaturedTier = "FEATURED" | "SPOTLIGHT";

export const FEATURED_LISTING_PRICING: Record<FeaturedTier, { amountCents: number; days: number }> = {
  FEATURED: { amountCents: 50_000_00, days: 7 },
  SPOTLIGHT: { amountCents: 120_000_00, days: 7 },
};

export const MAX_ACTIVE_SLOTS: Record<FeaturedTier, number> = {
  FEATURED: 3,
  SPOTLIGHT: 1,
};

export const BROADCAST_PRICE_PER_RECIPIENT_CENTS = 500_00; // TZS 500
export const BROADCAST_MIN_AMOUNT_CENTS = 25_000_00; // TZS 25,000 (= 50 recipients)
export const BROADCAST_MIN_RECIPIENTS = 50;
export const BROADCAST_MESSAGE_MAX_LENGTH = 160;

// Marks every ACTIVE listing past its endDate as EXPIRED. Called at the
// start of every marketplace read (getActiveFeaturedListings) and before
// every slot-availability check (createFeaturedListing) — there's no cron
// for this, same "check on read, not on a timer" posture as
// resale.ts's own listing-expiry handling.
export async function expireListings(now: Date = new Date()) {
  const result = await prisma.featuredListing.updateMany({
    where: { status: "ACTIVE", endDate: { lt: now } },
    data: { status: "EXPIRED" },
  });
  return result.count;
}

export interface ActiveFeaturedEntry {
  listingId: string;
  eventId: string;
  tier: FeaturedTier;
  endDate: string;
  event: {
    slug: string;
    title: string;
    imageUrl: string;
    city: string;
    venue: string;
    startsAt: string;
    currency: string;
    eventType: string;
    organizerName: string;
  };
}

const listingEventSelect = {
  slug: true,
  title: true,
  imageUrl: true,
  city: true,
  venue: true,
  startsAt: true,
  currency: true,
  eventType: true,
  organization: { select: { name: true } },
} as const;

function shapeListing(listing: {
  id: string;
  eventId: string;
  tier: string;
  endDate: Date;
  event: {
    slug: string;
    title: string;
    imageUrl: string;
    city: string;
    venue: string;
    startsAt: Date;
    currency: string;
    eventType: string;
    organization: { name: string };
  };
}): ActiveFeaturedEntry {
  const { organization, startsAt, ...rest } = listing.event;
  return {
    listingId: listing.id,
    eventId: listing.eventId,
    tier: listing.tier as FeaturedTier,
    endDate: listing.endDate.toISOString(),
    event: { ...rest, startsAt: startsAt.toISOString(), organizerName: organization.name },
  };
}

// The /events marketplace's one query for paid placement — SPOTLIGHT (at
// most one) and FEATURED (up to three), each in display order (oldest
// active listing first, so a listing doesn't jump around while it runs).
export async function getActiveFeaturedListings(now: Date = new Date()): Promise<{
  spotlight: ActiveFeaturedEntry | null;
  featured: ActiveFeaturedEntry[];
}> {
  await expireListings(now);

  const listings = await prisma.featuredListing.findMany({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "asc" },
    include: { event: { select: listingEventSelect } },
  });

  const shaped = listings.map(shapeListing);
  return {
    spotlight: shaped.find((l) => l.tier === "SPOTLIGHT") ?? null,
    featured: shaped.filter((l) => l.tier === "FEATURED"),
  };
}

// Remaining purchasable slots per tier, platform-wide — backs the
// dashboard's "Promote this event" tier picker (disable a tier once full).
export async function getFeaturedSlotAvailability(now: Date = new Date()): Promise<Record<FeaturedTier, number>> {
  await expireListings(now);
  const counts = await prisma.featuredListing.groupBy({
    by: ["tier"],
    where: { status: "ACTIVE" },
    _count: { _all: true },
  });
  const used: Record<FeaturedTier, number> = { FEATURED: 0, SPOTLIGHT: 0 };
  for (const c of counts) used[c.tier as FeaturedTier] = c._count._all;
  return {
    FEATURED: Math.max(0, MAX_ACTIVE_SLOTS.FEATURED - used.FEATURED),
    SPOTLIGHT: Math.max(0, MAX_ACTIVE_SLOTS.SPOTLIGHT - used.SPOTLIGHT),
  };
}

export interface FeaturedListingPayer {
  phoneNumber: string;
  mobileNetwork?: string;
}

// Starts (and, with the simulator or a synchronous provider approval,
// completes) a featured-listing purchase. Re-checks the slot cap under a
// fresh count at creation time too — two organisers racing the last
// SPOTLIGHT slot can't both succeed silently, same CAS-style discipline as
// purchaseSeasonPass's maxHolders re-check.
export async function createFeaturedListing(eventId: string, tier: FeaturedTier, organizationId: string, payer: FeaturedListingPayer) {
  if (tier !== "FEATURED" && tier !== "SPOTLIGHT") {
    return { ok: false as const, error: "Invalid tier." };
  }
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { organizationId: true, status: true, title: true } });
  if (!event || event.organizationId !== organizationId) return { ok: false as const, error: "Event not found." };
  if (event.status !== "LIVE") return { ok: false as const, error: "Only a live event can be promoted." };
  if (!payer.phoneNumber.trim()) return { ok: false as const, error: "Enter your mobile money number." };

  await expireListings();

  const existing = await prisma.featuredListing.findFirst({ where: { eventId, status: "ACTIVE" } });
  if (existing) return { ok: false as const, error: "This event already has an active featured listing." };

  const activeCount = await prisma.featuredListing.count({ where: { tier, status: "ACTIVE" } });
  if (activeCount >= MAX_ACTIVE_SLOTS[tier]) {
    return { ok: false as const, error: `All ${tier === "SPOTLIGHT" ? "Spotlight" : "Featured"} slots are taken right now. Try again later.` };
  }

  const pricing = FEATURED_LISTING_PRICING[tier];
  const charge = await getActivePaymentProvider().initiateCharge({
    orderClientId: `featured-listing-${eventId}-${tier}-${Date.now().toString(36)}`,
    amountCents: pricing.amountCents,
    phoneNumber: payer.phoneNumber,
    mobileNetwork: payer.mobileNetwork,
    description: `Chaap Ads — ${tier} listing for "${event.title}"`,
  });

  if (charge.status === "FAILED") {
    return { ok: false as const, error: charge.message ?? "The payment was declined." };
  }
  if (charge.status === "PENDING") {
    return { ok: true as const, status: "PENDING" as const, message: charge.message };
  }

  // Re-check under a CAS-style count at creation time, same reasoning as
  // purchaseSeasonPass's maxHolders re-check.
  const recount = await prisma.featuredListing.count({ where: { tier, status: "ACTIVE" } });
  if (recount >= MAX_ACTIVE_SLOTS[tier]) {
    return { ok: false as const, error: `All ${tier === "SPOTLIGHT" ? "Spotlight" : "Featured"} slots are taken right now. Try again later.` };
  }

  const startDate = new Date();
  const endDate = new Date(startDate.getTime() + pricing.days * 24 * 60 * 60 * 1000);
  const listing = await prisma.featuredListing.create({
    data: {
      eventId,
      organizationId,
      tier,
      startDate,
      endDate,
      amountPaidCents: pricing.amountCents,
      currency: DEFAULT_CURRENCY,
      status: "ACTIVE",
    },
  });

  return { ok: true as const, status: "CONFIRMED" as const, listingId: listing.id };
}

export interface FeaturedListingHistoryRow {
  id: string;
  eventId: string;
  eventTitle: string;
  tier: FeaturedTier;
  status: string;
  startDate: string;
  endDate: string;
  amountPaidCents: number;
  currency: string;
  // "Performance" — the event's own running page-view counter (see
  // Event.viewCount), not a delta scoped to this listing's exact window. A
  // simple total, per the spec's own "track via a simple view count on
  // Event" — not worth a separate start/end snapshot for a v1.
  eventViewCount: number;
}

export async function getFeaturedListingHistory(organizationId: string): Promise<FeaturedListingHistoryRow[]> {
  const listings = await prisma.featuredListing.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    include: { event: { select: { id: true, title: true, viewCount: true } } },
  });
  return listings.map((l) => ({
    id: l.id,
    eventId: l.event.id,
    eventTitle: l.event.title,
    tier: l.tier as FeaturedTier,
    status: l.status,
    startDate: l.startDate.toISOString(),
    endDate: l.endDate.toISOString(),
    amountPaidCents: l.amountPaidCents,
    currency: l.currency,
    eventViewCount: l.event.viewCount,
  }));
}

// Distinct platform-wide users with a phone number on file (see
// User.phone's own "only set at AIRPAY_ONLINE checkout" doc comment) who
// have at least one PAID order for an event of a matching type — the paid
// broadcast's actual audience. Deliberately platform-wide, not scoped to
// `organizationId`: reaching attendees the organiser DOESN'T already have a
// relationship with is the whole point of paying Chaap for this, as
// opposed to the free, own-event-only Broadcast tool
// (dashboard/customers/broadcast) that already exists.
export async function estimateBroadcastReach(targetEventTypes: string[]): Promise<number> {
  return prisma.user.count({
    where: {
      phone: { not: null },
      orders: {
        some: {
          status: "PAID",
          ...(targetEventTypes.length > 0 ? { event: { eventType: { in: targetEventTypes } } } : {}),
        },
      },
    },
  });
}

function broadcastAmountCents(reach: number): number {
  return Math.max(BROADCAST_MIN_AMOUNT_CENTS, reach * BROADCAST_PRICE_PER_RECIPIENT_CENTS);
}

export interface BroadcastPayer {
  phoneNumber: string;
  mobileNetwork?: string;
}

// Starts (and, with the simulator or a synchronous provider approval,
// completes) a broadcast purchase. Mirrors createFeaturedListing's charge
// shape — payment must clear before anything is created, so a broadcast
// only ever exists in a state that's already been paid for.
export async function createBroadcast(
  organizationId: string,
  message: string,
  targetEventTypes: string[],
  scheduledAt: Date,
  payer: BroadcastPayer
) {
  const trimmed = message.trim();
  if (!trimmed) return { ok: false as const, error: "Enter a message." };
  if (trimmed.length > BROADCAST_MESSAGE_MAX_LENGTH) {
    return { ok: false as const, error: `Message must be ${BROADCAST_MESSAGE_MAX_LENGTH} characters or fewer.` };
  }
  if (!payer.phoneNumber.trim()) return { ok: false as const, error: "Enter your mobile money number." };

  const estimatedReach = await estimateBroadcastReach(targetEventTypes);
  if (estimatedReach === 0) {
    return { ok: false as const, error: "No matching attendees to reach yet." };
  }
  const amountCents = broadcastAmountCents(estimatedReach);

  const charge = await getActivePaymentProvider().initiateCharge({
    orderClientId: `ad-broadcast-${organizationId}-${Date.now().toString(36)}`,
    amountCents,
    phoneNumber: payer.phoneNumber,
    mobileNetwork: payer.mobileNetwork,
    description: `Chaap Ads — WhatsApp broadcast to ~${estimatedReach} attendees`,
  });

  if (charge.status === "FAILED") {
    return { ok: false as const, error: charge.message ?? "The payment was declined." };
  }
  if (charge.status === "PENDING") {
    return { ok: true as const, status: "PENDING" as const, message: charge.message };
  }

  const broadcast = await prisma.adBroadcast.create({
    data: {
      organizationId,
      message: trimmed,
      targetEventTypes,
      scheduledAt,
      amountPaidCents: amountCents,
      currency: DEFAULT_CURRENCY,
      status: "SCHEDULED",
    },
  });

  return { ok: true as const, status: "CONFIRMED" as const, broadcastId: broadcast.id, estimatedReach, amountPaidCents: amountCents };
}

export interface SendBroadcastResult {
  broadcastId: string;
  recipientCount: number;
}

// Actually sends a SCHEDULED broadcast's WhatsApp messages. Called
// immediately after createBroadcast when the organiser chose "Send now"
// (scheduledAt <= now), or later from the broadcast history tab's own
// "Send now" button for one scheduled for a future time — there's no cron
// sweep wired up to fire those on their own (out of scope for this build;
// unlike season-renewal.ts's sweep, nothing in the spec asked for one).
export async function sendBroadcast(broadcastId: string): Promise<{ ok: true; result: SendBroadcastResult } | { ok: false; error: string }> {
  const broadcast = await prisma.adBroadcast.findUnique({ where: { id: broadcastId } });
  if (!broadcast) return { ok: false, error: "Broadcast not found." };
  if (broadcast.sentAt) return { ok: false, error: "This broadcast was already sent." };
  if (broadcast.status === "CANCELLED") return { ok: false, error: "This broadcast was cancelled." };

  const recipients = await prisma.user.findMany({
    where: {
      phone: { not: null },
      orders: {
        some: {
          status: "PAID",
          ...(broadcast.targetEventTypes.length > 0 ? { event: { eventType: { in: broadcast.targetEventTypes } } } : {}),
        },
      },
    },
    select: { phone: true },
  });

  for (const r of recipients) {
    await sendNotification({
      type: "AD_BROADCAST",
      channel: "WHATSAPP",
      recipient: r.phone!,
      subject: `Ad broadcast ${broadcast.id}`,
      body: broadcast.message,
    });
  }

  await prisma.adBroadcast.update({
    where: { id: broadcastId },
    data: { sentAt: new Date(), recipientCount: recipients.length, status: "SENT" },
  });

  return { ok: true, result: { broadcastId: broadcast.id, recipientCount: recipients.length } };
}

export interface BroadcastHistoryRow {
  id: string;
  message: string;
  targetEventTypes: string[];
  scheduledAt: string;
  sentAt: string | null;
  recipientCount: number;
  amountPaidCents: number;
  currency: string;
  status: string;
}

export async function getBroadcastHistory(organizationId: string): Promise<BroadcastHistoryRow[]> {
  const broadcasts = await prisma.adBroadcast.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
  });
  return broadcasts.map((b) => ({
    id: b.id,
    message: b.message,
    targetEventTypes: b.targetEventTypes,
    scheduledAt: b.scheduledAt.toISOString(),
    sentAt: b.sentAt ? b.sentAt.toISOString() : null,
    recipientCount: b.recipientCount,
    amountPaidCents: b.amountPaidCents,
    currency: b.currency,
    status: b.status,
  }));
}

export interface AdminAdsSummary {
  totalAdRevenueCentsThisMonth: number;
  currency: string;
  activeFeaturedListings: number;
  broadcastsSentThisMonth: number;
  totalBroadcastRecipientsThisMonth: number;
}

// Backs /admin/analytics' ads revenue section (item 6). Revenue is
// recognised at purchase time (when the AirPay charge cleared and the row
// was created), same as every other cents figure in this codebase — there's
// no refund path for either product, so a listing/broadcast row's own
// amountPaidCents is always the final number.
export async function getAdminAdsSummary(now: Date = new Date()): Promise<AdminAdsSummary> {
  await expireListings(now);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [listingAgg, broadcastAgg, activeFeaturedListings, broadcastsSentThisMonth] = await Promise.all([
    prisma.featuredListing.aggregate({
      _sum: { amountPaidCents: true },
      where: { currency: DEFAULT_CURRENCY, createdAt: { gte: monthStart } },
    }),
    prisma.adBroadcast.aggregate({
      _sum: { amountPaidCents: true, recipientCount: true },
      where: { currency: DEFAULT_CURRENCY, createdAt: { gte: monthStart } },
    }),
    prisma.featuredListing.count({ where: { status: "ACTIVE" } }),
    prisma.adBroadcast.count({ where: { status: "SENT", createdAt: { gte: monthStart } } }),
  ]);

  return {
    totalAdRevenueCentsThisMonth: (listingAgg._sum.amountPaidCents ?? 0) + (broadcastAgg._sum.amountPaidCents ?? 0),
    currency: DEFAULT_CURRENCY,
    activeFeaturedListings,
    broadcastsSentThisMonth,
    totalBroadcastRecipientsThisMonth: broadcastAgg._sum.recipientCount ?? 0,
  };
}
