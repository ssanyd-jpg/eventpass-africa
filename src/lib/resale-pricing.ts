import { formatCents } from "@/lib/format";

// Session 32 — the DB-free half of ticket resale: pricing rules and the
// commission summary. Split out of resale.ts because the seller's ticket page
// (a client component) needs the commission maths and it must not drag
// Prisma into the browser bundle. Same reason analytics.ts is kept DB-free.

// Chaap's cut of every completed resale, taken off the seller's side: the
// buyer pays the asking price, the seller is owed asking minus this.
export const RESALE_COMMISSION_RATE = 0.05;

export const LISTING_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

// How long a listing is held for one buyer while their mobile-money charge
// is awaiting confirmation on their phone.
export const RESERVATION_MS = 10 * 60 * 1000;

export function calculateCommission(askingPrice: number): { commissionAmount: number; sellerPayoutAmount: number } {
  const commissionAmount = Math.round(askingPrice * RESALE_COMMISSION_RATE);
  return { commissionAmount, sellerPayoutAmount: askingPrice - commissionAmount };
}

// The highest price a ticket may be listed at: its face value, lowered further
// by the organiser's optional per-event cap. Never above face value — there is
// no way to configure a markup.
export function maxListingPrice(originalPrice: number, maxResalePrice: number | null): number {
  return maxResalePrice != null ? Math.min(originalPrice, maxResalePrice) : originalPrice;
}

export function validateAskingPrice(
  askingPrice: unknown,
  originalPrice: number,
  maxResalePrice: number | null,
  currency: string
): { ok: true; askingPrice: number } | { ok: false; error: string } {
  if (typeof askingPrice !== "number" || !Number.isInteger(askingPrice) || askingPrice <= 0) {
    return { ok: false, error: "Enter a valid price." };
  }
  const cap = maxListingPrice(originalPrice, maxResalePrice);
  if (askingPrice > cap) {
    const reason = cap < originalPrice ? "the organiser's maximum resale price" : "the ticket's face value";
    return { ok: false, error: `The price can't be more than ${reason} (${formatCents(cap, currency)}).` };
  }
  return { ok: true, askingPrice };
}

// A listing lives 7 days, but never past the moment the event starts — a
// listing that outlived the event would be a way to sell a dead ticket.
export function listingExpiresAt(now: Date, eventStartsAt: Date): Date {
  return new Date(Math.min(now.getTime() + LISTING_EXPIRY_MS, eventStartsAt.getTime()));
}

// ---------------------------------------------------------------------------
// Commission reporting — pure summary, same split as summarizeGroupSales in
// ticket-groups.ts. The query that feeds it is getOrganizerResaleListings in
// resale.ts.
// ---------------------------------------------------------------------------

export interface ResaleRevenueStats {
  salesCount: number;
  volumeByCurrency: Record<string, number>;
  commissionByCurrency: Record<string, number>;
}

// Only SOLD listings count: an ACTIVE/CANCELLED/EXPIRED one never moved money.
export function summarizeResaleRevenue(
  listings: { status: string; askingPrice: number; commissionAmount: number; currency: string }[]
): ResaleRevenueStats {
  const volumeByCurrency: Record<string, number> = {};
  const commissionByCurrency: Record<string, number> = {};
  let salesCount = 0;
  for (const l of listings) {
    if (l.status !== "SOLD") continue;
    salesCount += 1;
    volumeByCurrency[l.currency] = (volumeByCurrency[l.currency] ?? 0) + l.askingPrice;
    commissionByCurrency[l.currency] = (commissionByCurrency[l.currency] ?? 0) + l.commissionAmount;
  }
  return { salesCount, volumeByCurrency, commissionByCurrency };
}
