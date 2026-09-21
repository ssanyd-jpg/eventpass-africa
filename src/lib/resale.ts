import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/notifications";
import { formatCents } from "@/lib/format";
import { normalizeTanzaniaPhone } from "@/lib/sms";
import { getActivePaymentProvider } from "@/lib/payments";
import { verifyAirpayOrder } from "@/lib/payments/airpay";
import {
  RESALE_COMMISSION_RATE,
  LISTING_EXPIRY_MS,
  RESERVATION_MS,
  calculateCommission,
  maxListingPrice,
  validateAskingPrice,
  listingExpiresAt,
  summarizeResaleRevenue,
} from "@/lib/resale-pricing";

export {
  RESALE_COMMISSION_RATE,
  LISTING_EXPIRY_MS,
  RESERVATION_MS,
  calculateCommission,
  maxListingPrice,
  validateAskingPrice,
  listingExpiresAt,
  summarizeResaleRevenue,
};
export type { ResaleRevenueStats } from "@/lib/resale-pricing";

// Session 32 — peer-to-peer ticket resale. Business logic behind the resale
// routes and pages, extracted for the same reason ticket-transfer.ts is:
// testable directly, without HTTP/session plumbing. Like a transfer, resale
// is an inherently online action — a plain authenticated route, not a
// queueOp/sync mutation.
//
// A resale is a *transfer of an existing ticket*, not a new sale: no
// TicketType inventory is touched (the seller's ticket already counted in
// quantitySold), and the buyer gets no new Order — the ticket simply moves to
// them via Ticket.currentHolderUserId, exactly as an accepted TicketTransfer
// does (see ticket-transfer.ts).

// Whoever holds the ticket right now — same fallback as ticket-transfer.ts.
function currentHolder(ticket: { currentHolderUserId: string | null; order: { userId: string } }) {
  return ticket.currentHolderUserId ?? ticket.order.userId;
}

function listingLink(ticketId: string) {
  return `${process.env.NEXTAUTH_URL ?? ""}/account/tickets/${ticketId}`;
}

async function whatsappTo(userId: string, subject: string, body: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { phone: true } });
  if (!user?.phone) return;
  await sendNotification({ type: "TICKET_RESALE", channel: "WHATSAPP", recipient: user.phone, subject, body });
}

// Flips every ACTIVE listing whose time is up to EXPIRED. Called lazily
// before anything reads or acts on listings (Vercel's Hobby plan allows only
// two cron jobs, and both are taken), and every read below also filters on
// expiresAt itself, so correctness never depends on this having run. A
// listing a buyer is mid-payment on is left alone until that resolves.
export async function expireStaleListings(now: Date = new Date()): Promise<number> {
  const res = await prisma.ticketListing.updateMany({
    where: {
      status: "ACTIVE",
      expiresAt: { lt: now },
      OR: [{ reservedUntil: null }, { reservedUntil: { lte: now } }],
    },
    data: { status: "EXPIRED", reservedByUserId: null, reservedUntil: null },
  });
  return res.count;
}

// Every reason a ticket can't be put up for resale right now, as the message
// to show. Shared by createListing (enforcement) and getTicketResaleState (what
// the ticket page shows), so the page never offers a button the API would
// refuse. Assumes the caller has already checked the user holds the ticket.
function listingBlocker(
  ticket: {
    checkedIn: boolean;
    checkedInAt: Date | null;
    order: { status: string };
    event: { status: string; startsAt: Date; resaleEnabled: boolean };
    listing: { status: string } | null;
    transfers: { id: string }[];
  },
  now: Date
): string | null {
  if (!ticket.event.resaleEnabled) return "Resale isn't enabled for this event.";
  if (ticket.event.status !== "LIVE") return "This event isn't on sale, so its tickets can't be resold.";
  if (ticket.order.status !== "PAID") return "Only paid tickets can be listed for resale.";
  if (ticket.checkedIn || ticket.checkedInAt) return "This ticket has already been used to check in and can't be listed.";
  if (ticket.event.startsAt <= now) return "This event has already started, so the ticket can't be listed.";
  if (ticket.transfers.length > 0) return "This ticket has a pending transfer. Cancel it before listing the ticket for resale.";
  if (ticket.listing?.status === "ACTIVE") return "This ticket is already listed for resale.";
  if (ticket.listing?.status === "SOLD") return "This ticket was already bought through resale and can't be resold again.";
  return null;
}

export async function createListing(userId: string, ticketId: string, askingPrice: unknown, now: Date = new Date()) {
  await expireStaleListings(now);

  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: {
      order: { select: { userId: true, status: true, currency: true, items: true } },
      event: { select: { id: true, title: true, status: true, startsAt: true, resaleEnabled: true, maxResalePrice: true, currency: true } },
      ticketType: { select: { name: true, priceCents: true } },
      listing: true,
      transfers: { where: { status: "PENDING", expiresAt: { gt: now } }, select: { id: true } },
    },
  });
  if (!ticket) return { ok: false as const, error: "Ticket not found." };
  if (currentHolder(ticket) !== userId) return { ok: false as const, error: "This isn't your ticket to sell." };
  const blocker = listingBlocker(ticket, now);
  if (blocker) return { ok: false as const, error: blocker };

  // Face value = what this ticket's type was priced at when the order was
  // placed (OrderItem snapshots it) — not Order.totalCents, which can include
  // other tickets and discounts. Falls back to the ticket type's current
  // price only for an order with no matching line (shouldn't happen).
  const originalPrice =
    ticket.order.items.find((i) => i.ticketTypeId === ticket.ticketTypeId)?.unitPriceCents ?? ticket.ticketType.priceCents;
  if (originalPrice <= 0) return { ok: false as const, error: "Free tickets can't be resold." };

  const currency = ticket.order.currency;
  const priceCheck = validateAskingPrice(askingPrice, originalPrice, ticket.event.maxResalePrice, currency);
  if (!priceCheck.ok) return { ok: false as const, error: priceCheck.error };

  const data = {
    askingPrice: priceCheck.askingPrice,
    originalPrice,
    currency,
    status: "ACTIVE",
    listedAt: now,
    expiresAt: listingExpiresAt(now, ticket.event.startsAt),
    soldAt: null,
    buyerId: null,
    commissionAmount: 0,
    sellerPayoutAmount: 0,
    payoutStatus: "NONE",
    reservedByUserId: null,
    reservedUntil: null,
    paymentReference: null,
    sellerId: userId,
    eventId: ticket.event.id,
  };

  let listingId: string;
  if (ticket.listing) {
    // A CANCELLED/EXPIRED row is reused. The status filter makes this a CAS,
    // so two concurrent relists can't both win.
    const res = await prisma.ticketListing.updateMany({
      where: { id: ticket.listing.id, status: { in: ["CANCELLED", "EXPIRED"] } },
      data,
    });
    if (res.count === 0) return { ok: false as const, error: "This ticket is already listed for resale." };
    listingId = ticket.listing.id;
  } else {
    try {
      const created = await prisma.ticketListing.create({ data: { ...data, ticketId: ticket.id } });
      listingId = created.id;
    } catch (err) {
      // ticketId is unique — a racing second listing loses here.
      if ((err as { code?: string }).code === "P2002") {
        return { ok: false as const, error: "This ticket is already listed for resale." };
      }
      throw err;
    }
  }

  const { sellerPayoutAmount } = calculateCommission(priceCheck.askingPrice);
  await whatsappTo(
    userId,
    "Ticket listed for resale",
    `🎟 Your ${ticket.ticketType.name} ticket for ${ticket.event.title} is now listed for resale at ${formatCents(priceCheck.askingPrice, currency)}. ` +
      `When it sells you'll receive ${formatCents(sellerPayoutAmount, currency)} after Chaap's ${RESALE_COMMISSION_RATE * 100}% commission. Manage it here: ${listingLink(ticket.id)}`
  );

  return { ok: true as const, listingId, askingPrice: priceCheck.askingPrice, originalPrice, currency };
}

export async function cancelListing(userId: string, listingId: string, now: Date = new Date()) {
  const listing = await prisma.ticketListing.findUnique({ where: { id: listingId } });
  if (!listing || listing.sellerId !== userId) return { ok: false as const, error: "Listing not found." };
  if (listing.status !== "ACTIVE") return { ok: false as const, error: "This listing can no longer be cancelled." };

  // Not while a buyer's payment is in flight — it would strand their charge.
  const res = await prisma.ticketListing.updateMany({
    where: {
      id: listing.id,
      sellerId: userId,
      status: "ACTIVE",
      OR: [{ reservedUntil: null }, { reservedUntil: { lte: now } }],
    },
    data: { status: "CANCELLED", reservedByUserId: null, reservedUntil: null },
  });
  if (res.count === 0) {
    return { ok: false as const, error: "A buyer is completing payment for this ticket right now. Try again in a few minutes." };
  }
  return { ok: true as const };
}

export interface TicketResaleState {
  ticketId: string;
  code: string;
  checkedIn: boolean;
  eventTitle: string;
  eventSlug: string;
  eventStartsAt: string;
  ticketTypeName: string;
  currency: string;
  originalPrice: number;
  // Highest price the seller may ask: face value, or the organiser's lower cap.
  maxPrice: number;
  // Non-null = the ticket can't be listed right now, and why.
  cannotListReason: string | null;
  listing: { id: string; askingPrice: number; expiresAt: string | null; sellerPayoutAmount: number; buyerPaying: boolean } | null;
}

// The ticket page's data — only for the ticket's current holder (null for
// anyone else, so the page can 404 rather than reveal a ticket's details).
export async function getTicketResaleState(userId: string, ticketId: string, now: Date = new Date()): Promise<TicketResaleState | null> {
  await expireStaleListings(now);
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: {
      order: { select: { userId: true, status: true, currency: true, items: true } },
      event: { select: { title: true, slug: true, status: true, startsAt: true, resaleEnabled: true, maxResalePrice: true } },
      ticketType: { select: { name: true, priceCents: true } },
      listing: true,
      transfers: { where: { status: "PENDING", expiresAt: { gt: now } }, select: { id: true } },
    },
  });
  if (!ticket || currentHolder(ticket) !== userId) return null;

  const originalPrice =
    ticket.order.items.find((i) => i.ticketTypeId === ticket.ticketTypeId)?.unitPriceCents ?? ticket.ticketType.priceCents;
  const activeListing = ticket.listing?.status === "ACTIVE" ? ticket.listing : null;
  const blocker = activeListing ? null : listingBlocker(ticket, now);

  return {
    ticketId: ticket.id,
    code: ticket.code,
    checkedIn: ticket.checkedIn,
    eventTitle: ticket.event.title,
    eventSlug: ticket.event.slug,
    eventStartsAt: ticket.event.startsAt.toISOString(),
    ticketTypeName: ticket.ticketType.name,
    currency: ticket.order.currency,
    originalPrice,
    maxPrice: maxListingPrice(originalPrice, ticket.event.maxResalePrice),
    cannotListReason: activeListing ? null : originalPrice <= 0 ? "Free tickets can't be resold." : blocker,
    listing: activeListing
      ? {
          id: activeListing.id,
          askingPrice: activeListing.askingPrice,
          expiresAt: activeListing.expiresAt ? activeListing.expiresAt.toISOString() : null,
          sellerPayoutAmount: calculateCommission(activeListing.askingPrice).sellerPayoutAmount,
          buyerPaying: !!activeListing.reservedUntil && activeListing.reservedUntil > now,
        }
      : null,
  };
}

export interface PublicListing {
  id: string;
  ticketTypeName: string;
  askingPrice: number;
  originalPrice: number;
  savings: number;
  currency: string;
  expiresAt: string | null;
  // True when the viewer is the seller — the page shows "Your listing"
  // instead of a buy button. The seller's identity is never exposed.
  isOwn: boolean;
}

const liveListingWhere = (now: Date) => ({
  status: "ACTIVE",
  OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
});

export async function getActiveListingsForEvent(eventId: string, viewerUserId: string | null, now: Date = new Date()): Promise<PublicListing[]> {
  await expireStaleListings(now);
  const listings = await prisma.ticketListing.findMany({
    where: { eventId, ...liveListingWhere(now) },
    include: { ticket: { select: { ticketType: { select: { name: true } } } } },
    orderBy: { askingPrice: "asc" },
  });
  return listings.map((l) => ({
    id: l.id,
    ticketTypeName: l.ticket.ticketType.name,
    askingPrice: l.askingPrice,
    originalPrice: l.originalPrice,
    savings: l.originalPrice - l.askingPrice,
    currency: l.currency,
    expiresAt: l.expiresAt ? l.expiresAt.toISOString() : null,
    isOwn: viewerUserId !== null && l.sellerId === viewerUserId,
  }));
}

export async function countActiveListings(eventId: string, now: Date = new Date()): Promise<number> {
  return prisma.ticketListing.count({ where: { eventId, ...liveListingWhere(now) } });
}

export interface PurchaseInput {
  phoneNumber: string;
  mobileNetwork?: string;
}

// Finishes a resale whose payment has been confirmed: the listing goes SOLD,
// the commission is recorded, and the ticket moves to the buyer — all in one
// transaction, so a listing can never be SOLD with the ticket still with the
// seller (or the reverse). Idempotent and race-safe: both the status CAS and
// the ticket CAS must match, and only the caller that wins them notifies.
async function completeResale(listingId: string, buyerId: string, now: Date) {
  const listing = await prisma.ticketListing.findUniqueOrThrow({
    where: { id: listingId },
    include: {
      ticket: { select: { id: true, ticketType: { select: { name: true } } } },
      event: { select: { title: true } },
    },
  });
  const { commissionAmount, sellerPayoutAmount } = calculateCommission(listing.askingPrice);

  class TransferFailed extends Error {}
  let outcome: "SOLD" | "ALREADY_RESOLVED";
  try {
    outcome = await prisma.$transaction(
      async (tx) => {
        const res = await tx.ticketListing.updateMany({
          where: { id: listing.id, status: "ACTIVE", reservedByUserId: buyerId },
          data: {
            status: "SOLD",
            buyerId,
            soldAt: now,
            commissionAmount,
            sellerPayoutAmount,
            payoutStatus: "PENDING",
            reservedByUserId: null,
            reservedUntil: null,
          },
        });
        if (res.count === 0) return "ALREADY_RESOLVED" as const;

        // The ticket must still be unused and still with the seller. If not
        // (they checked in, or moved it, while the payment was pending), the
        // whole transaction rolls back and the listing is left untouched.
        const moved = await tx.ticket.updateMany({
          where: {
            id: listing.ticketId,
            checkedIn: false,
            OR: [{ currentHolderUserId: listing.sellerId }, { currentHolderUserId: null, order: { userId: listing.sellerId } }],
          },
          data: { currentHolderUserId: buyerId },
        });
        if (moved.count === 0) throw new TransferFailed();

        // A transfer the seller had pending can no longer be accepted.
        await tx.ticketTransfer.updateMany({
          where: { ticketId: listing.ticketId, status: "PENDING" },
          data: { status: "CANCELLED" },
        });
        return "SOLD" as const;
      },
      { timeout: 15000, maxWait: 10000 }
    );
  } catch (err) {
    if (!(err instanceof TransferFailed)) throw err;
    // Payment was collected but the ticket can't move. There is no refund API
    // in the payment provider layer (payments/airpay.ts has none), so this is
    // surfaced for a human to refund: the listing is closed and the buyer told.
    await prisma.ticketListing.updateMany({
      where: { id: listing.id, status: "ACTIVE", reservedByUserId: buyerId },
      data: { status: "CANCELLED", reservedByUserId: null, reservedUntil: null },
    });
    await whatsappTo(
      buyerId,
      "Resale ticket unavailable",
      `⚠️ We couldn't complete your purchase of a ${listing.ticket.ticketType.name} ticket for ${listing.event.title} because the ticket is no longer available. Your payment will be refunded — contact Chaap support if you don't see it.`
    );
    return { ok: false as const, reason: "TICKET_UNAVAILABLE" as const, error: "That ticket is no longer available. You'll be refunded." };
  }

  // Lost the race to another completion (e.g. two polls at once) — the winner
  // already sent the notifications.
  if (outcome === "ALREADY_RESOLVED") {
    return { ok: true as const, status: "SOLD" as const, ticketId: listing.ticketId, notified: false };
  }

  const price = formatCents(listing.askingPrice, listing.currency);
  await whatsappTo(
    buyerId,
    "Resale ticket purchased",
    `🎟 You bought a ${listing.ticket.ticketType.name} ticket for ${listing.event.title} (${price}). It's in your Chaap account now: ${listingLink(listing.ticketId)}`
  );
  await whatsappTo(
    listing.sellerId,
    "Your ticket sold",
    `✅ Your ${listing.ticket.ticketType.name} ticket for ${listing.event.title} sold for ${price}. ` +
      `After Chaap's ${RESALE_COMMISSION_RATE * 100}% commission (${formatCents(commissionAmount, listing.currency)}) you'll receive ${formatCents(sellerPayoutAmount, listing.currency)}.`
  );
  return { ok: true as const, status: "SOLD" as const, ticketId: listing.ticketId, notified: true };
}

async function releaseReservation(listingId: string, buyerId: string) {
  await prisma.ticketListing.updateMany({
    where: { id: listingId, status: "ACTIVE", reservedByUserId: buyerId },
    data: { reservedByUserId: null, reservedUntil: null, paymentReference: null },
  });
}

// Starts a purchase: validates, reserves the listing for this buyer, charges
// the asking price. With the simulator (or a synchronous approval) it
// completes immediately; with real AirPay the charge is PENDING until the
// buyer confirms on their phone and checkResalePurchase resolves it.
export async function purchaseListing(buyerId: string, listingId: string, input: PurchaseInput, now: Date = new Date()) {
  await expireStaleListings(now);

  const listing = await prisma.ticketListing.findUnique({
    where: { id: listingId },
    include: {
      ticket: { include: { order: { select: { userId: true } } } },
      event: { select: { title: true, status: true, startsAt: true, resaleEnabled: true } },
    },
  });
  if (!listing) return { ok: false as const, error: "Listing not found." };
  if (listing.sellerId === buyerId) return { ok: false as const, error: "You can't buy your own listing." };
  if (listing.status !== "ACTIVE" || (listing.expiresAt && listing.expiresAt <= now)) {
    return { ok: false as const, error: "This listing is no longer available." };
  }
  if (!listing.event.resaleEnabled || listing.event.status !== "LIVE") {
    return { ok: false as const, error: "Resale is no longer available for this event." };
  }
  if (listing.event.startsAt <= now) return { ok: false as const, error: "This event has already started." };
  if (listing.ticket.checkedIn || listing.ticket.checkedInAt) {
    return { ok: false as const, error: "This ticket has already been used and is no longer available." };
  }
  if (currentHolder(listing.ticket) !== listing.sellerId) {
    return { ok: false as const, error: "This ticket is no longer available." };
  }
  if (!input.phoneNumber.trim()) return { ok: false as const, error: "Enter your mobile money number." };

  // Reserve first, charge second: two buyers can't both be charged for the
  // one ticket. A reservation held by someone else blocks this until it lapses.
  const reserved = await prisma.ticketListing.updateMany({
    where: {
      id: listing.id,
      status: "ACTIVE",
      OR: [{ reservedUntil: null }, { reservedUntil: { lte: now } }, { reservedByUserId: buyerId }],
    },
    data: { reservedByUserId: buyerId, reservedUntil: new Date(now.getTime() + RESERVATION_MS) },
  });
  if (reserved.count === 0) {
    return { ok: false as const, error: "Someone else is buying this ticket right now. Try again in a few minutes." };
  }

  // Same opportunistic phone capture as checkout — the number is the only way
  // to reach this buyer by WhatsApp afterwards.
  await prisma.user.update({ where: { id: buyerId }, data: { phone: normalizeTanzaniaPhone(input.phoneNumber) } });

  let charge;
  try {
    charge = await getActivePaymentProvider().initiateCharge({
      orderClientId: `resale-${listing.id}-${now.getTime().toString(36)}`,
      amountCents: listing.askingPrice,
      phoneNumber: input.phoneNumber,
      mobileNetwork: input.mobileNetwork,
      description: `Resale ticket — ${listing.event.title}`,
    });
  } catch (err) {
    await releaseReservation(listing.id, buyerId);
    throw err;
  }

  if (charge.status === "FAILED") {
    await releaseReservation(listing.id, buyerId);
    return { ok: false as const, error: charge.message ?? "The payment was declined." };
  }

  await prisma.ticketListing.updateMany({
    where: { id: listing.id, reservedByUserId: buyerId },
    data: { paymentReference: charge.reference },
  });

  if (charge.status === "PENDING") {
    return { ok: true as const, status: "PENDING" as const, listingId: listing.id, message: charge.message };
  }
  return completeResale(listing.id, buyerId, now);
}

// Polled by the buyer's browser after a PENDING charge — mirrors
// handleCheckOrderPaymentStatus (there is no AirPay webhook, only Order
// Verification). Only the buyer who holds the reservation can resolve it.
export async function checkResalePurchase(buyerId: string, listingId: string, now: Date = new Date()) {
  const listing = await prisma.ticketListing.findUnique({ where: { id: listingId } });
  if (!listing) return { ok: false as const, error: "Listing not found." };

  if (listing.status === "SOLD") {
    return listing.buyerId === buyerId
      ? { ok: true as const, status: "SOLD" as const, ticketId: listing.ticketId }
      : { ok: false as const, error: "This listing is no longer available." };
  }
  if (listing.status !== "ACTIVE" || listing.reservedByUserId !== buyerId || !listing.paymentReference) {
    return { ok: false as const, error: "There's no payment in progress for this listing." };
  }

  const result = await verifyAirpayOrder(listing.paymentReference);
  if (result.status === "PENDING") return { ok: true as const, status: "PENDING" as const };
  if (result.status === "FAILED") {
    await releaseReservation(listing.id, buyerId);
    return { ok: true as const, status: "FAILED" as const, error: result.message ?? "The payment was not confirmed." };
  }
  return completeResale(listing.id, buyerId, now);
}


export async function getOrganizerResaleListings(organizationId: string) {
  return prisma.ticketListing.findMany({
    where: { status: "SOLD", event: { organizationId } },
    select: { status: true, askingPrice: true, commissionAmount: true, currency: true },
  });
}
