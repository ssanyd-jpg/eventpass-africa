import { prisma } from "@/lib/prisma";

// Session 27 — dynamic pricing for TicketType. FIXED behaves exactly as
// before (priceCents as-is); TIERED steps the price up as quantitySold
// crosses each PricingTier.fromQuantity threshold. Price only ever
// increases: once quantitySold reaches a threshold it never falls back
// below it (quantitySold itself never decrements on a completed sale), so
// the highest reached tier always wins.

export interface PricingTierInput {
  fromQuantity: number;
  priceCents: number;
}

export interface TicketTypePricingInput {
  priceCents: number;
  pricingStrategy: string;
  quantitySold: number;
}

// Pure — no Prisma. Prefer this directly wherever the ticket type and its
// tiers are already loaded (e.g. inside handleSellTickets' own
// transaction) to avoid a redundant query; getCurrentPrice below is a thin
// DB-backed convenience wrapper around it.
export function currentPriceCents(ticketType: TicketTypePricingInput, tiers: PricingTierInput[]): number {
  if (ticketType.pricingStrategy !== "TIERED" || tiers.length === 0) {
    return ticketType.priceCents;
  }
  const reached = tiers
    .filter((t) => ticketType.quantitySold >= t.fromQuantity)
    .sort((a, b) => b.fromQuantity - a.fromQuantity);
  return reached.length > 0 ? reached[0].priceCents : ticketType.priceCents;
}

export async function getCurrentPrice(ticketTypeId: string): Promise<number> {
  const tt = await prisma.ticketType.findUnique({
    where: { id: ticketTypeId },
    include: { pricingTiers: true },
  });
  if (!tt) throw new Error("TICKET_TYPE_NOT_FOUND");
  return currentPriceCents(tt, tt.pricingTiers);
}

// The next threshold ahead of where quantitySold is now — powers the event
// page's urgency note ("price increases to TZS 40,000 after 300 sold").
// null once TIERED has reached its top tier, or for FIXED.
export function nextTierInfo(
  ticketType: TicketTypePricingInput,
  tiers: PricingTierInput[]
): { priceCents: number; atQuantity: number } | null {
  if (ticketType.pricingStrategy !== "TIERED" || tiers.length === 0) return null;
  const upcoming = tiers
    .filter((t) => ticketType.quantitySold < t.fromQuantity)
    .sort((a, b) => a.fromQuantity - b.fromQuantity);
  return upcoming.length > 0 ? { priceCents: upcoming[0].priceCents, atQuantity: upcoming[0].fromQuantity } : null;
}

// Organiser tier-table validation — tiers must be submitted in ascending
// fromQuantity order with strictly ascending price, per spec. Called at the
// EDIT_EVENT sync-handler boundary (see handleEditEvent in sync-handlers.ts),
// same "validated in code, not by the DB" discipline as every other
// plain-string enum field in this schema.
export function validatePricingTiers(tiers: PricingTierInput[]): { ok: true } | { ok: false; reason: string } {
  if (tiers.length === 0) return { ok: false, reason: "TIERS_REQUIRED" };
  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i].fromQuantity <= tiers[i - 1].fromQuantity) {
      return { ok: false, reason: "TIERS_NOT_ASCENDING_QUANTITY" };
    }
    if (tiers[i].priceCents <= tiers[i - 1].priceCents) {
      return { ok: false, reason: "TIERS_NOT_ASCENDING_PRICE" };
    }
  }
  return { ok: true };
}
