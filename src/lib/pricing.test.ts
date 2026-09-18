import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestEvent, createTestOrganization, createTestUser } from "@/lib/test-fixtures";
import { handleSellTickets, payloadSchemas } from "@/lib/sync-handlers";
import { currentPriceCents, getCurrentPrice, nextTierInfo, validatePricingTiers } from "@/lib/pricing";

// Early bird (0–100 sold) TZS 20,000 -> Standard (101–300 sold) TZS 30,000
// -> Late (301+) TZS 40,000 — the exact example from the spec.
const TIERS = [
  { fromQuantity: 0, priceCents: 2000000 },
  { fromQuantity: 100, priceCents: 3000000 },
  { fromQuantity: 300, priceCents: 4000000 },
];

function uniqueCode() {
  return `CODE-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

describe("currentPriceCents", () => {
  it("returns the base price for FIXED regardless of tiers present", () => {
    const price = currentPriceCents({ priceCents: 500000, pricingStrategy: "FIXED", quantitySold: 250 }, TIERS);
    expect(price).toBe(500000);
  });

  it("returns the first tier's price before any threshold is crossed", () => {
    const price = currentPriceCents({ priceCents: 999, pricingStrategy: "TIERED", quantitySold: 0 }, TIERS);
    expect(price).toBe(2000000);
  });

  it("returns the correct tier at each threshold", () => {
    expect(currentPriceCents({ priceCents: 999, pricingStrategy: "TIERED", quantitySold: 99 }, TIERS)).toBe(2000000);
    expect(currentPriceCents({ priceCents: 999, pricingStrategy: "TIERED", quantitySold: 100 }, TIERS)).toBe(3000000);
    expect(currentPriceCents({ priceCents: 999, pricingStrategy: "TIERED", quantitySold: 299 }, TIERS)).toBe(3000000);
    expect(currentPriceCents({ priceCents: 999, pricingStrategy: "TIERED", quantitySold: 300 }, TIERS)).toBe(4000000);
    expect(currentPriceCents({ priceCents: 999, pricingStrategy: "TIERED", quantitySold: 1000 }, TIERS)).toBe(4000000);
  });

  it("never drops back below the highest reached tier, even with a gap between thresholds", () => {
    // No tier starts exactly at 150 — the highest one BELOW it (100) must
    // still win, never falling back to a lower tier or the base price.
    const price = currentPriceCents({ priceCents: 999, pricingStrategy: "TIERED", quantitySold: 150 }, TIERS);
    expect(price).toBe(3000000);
    expect(price).toBeGreaterThan(2000000);
  });

  it("falls back to the base price for TIERED with no tiers configured", () => {
    const price = currentPriceCents({ priceCents: 500000, pricingStrategy: "TIERED", quantitySold: 500 }, []);
    expect(price).toBe(500000);
  });
});

describe("nextTierInfo", () => {
  it("shows the next threshold ahead of the current quantitySold", () => {
    const info = nextTierInfo({ priceCents: 999, pricingStrategy: "TIERED", quantitySold: 150 }, TIERS);
    expect(info).toEqual({ priceCents: 4000000, atQuantity: 300 });
  });

  it("returns null once the top tier has been reached", () => {
    const info = nextTierInfo({ priceCents: 999, pricingStrategy: "TIERED", quantitySold: 300 }, TIERS);
    expect(info).toBeNull();
  });

  it("returns null for FIXED pricing", () => {
    const info = nextTierInfo({ priceCents: 999, pricingStrategy: "FIXED", quantitySold: 0 }, TIERS);
    expect(info).toBeNull();
  });
});

describe("validatePricingTiers", () => {
  it("accepts strictly ascending quantity and price", () => {
    expect(validatePricingTiers(TIERS)).toEqual({ ok: true });
  });

  it("rejects non-ascending quantity", () => {
    const result = validatePricingTiers([
      { fromQuantity: 100, priceCents: 2000000 },
      { fromQuantity: 100, priceCents: 3000000 },
    ]);
    expect(result).toEqual({ ok: false, reason: "TIERS_NOT_ASCENDING_QUANTITY" });
  });

  it("rejects non-ascending price", () => {
    const result = validatePricingTiers([
      { fromQuantity: 0, priceCents: 3000000 },
      { fromQuantity: 100, priceCents: 2000000 },
    ]);
    expect(result).toEqual({ ok: false, reason: "TIERS_NOT_ASCENDING_PRICE" });
  });

  it("rejects an empty tier list", () => {
    expect(validatePricingTiers([])).toEqual({ ok: false, reason: "TIERS_REQUIRED" });
  });
});

describe("getCurrentPrice", () => {
  it("resolves the current tier price straight from the database", async () => {
    const organization = await createTestOrganization();
    const event = await createTestEvent(organization.id, [
      { priceCents: 999, quantityTotal: 500, quantitySold: 150, pricingStrategy: "TIERED", pricingTiers: TIERS },
    ]);
    const price = await getCurrentPrice(event.ticketTypes[0].id);
    expect(price).toBe(3000000);
  });

  it("returns the plain priceCents for a FIXED ticket type", async () => {
    const organization = await createTestOrganization();
    const event = await createTestEvent(organization.id, [{ priceCents: 500000, quantityTotal: 10 }]);
    const price = await getCurrentPrice(event.ticketTypes[0].id);
    expect(price).toBe(500000);
  });
});

describe("checkout uses the dynamic price", () => {
  it("charges the tier price current at the moment of purchase, not the base price", async () => {
    const organization = await createTestOrganization();
    const buyer = await createTestUser();
    // Already at 100 sold, right at the Standard threshold — the very next
    // sale must be charged TZS 30,000, not the TZS 20,000 base priceCents.
    const event = await createTestEvent(organization.id, [
      { priceCents: 999, quantityTotal: 500, quantitySold: 100, pricingStrategy: "TIERED", pricingTiers: TIERS },
    ]);
    const ticketTypeId = event.ticketTypes[0].id;

    const result = await handleSellTickets(buyer.id, {
      clientId: uniqueCode(),
      eventId: event.id,
      items: [{ ticketTypeId, quantity: 1, codes: [uniqueCode()] }],
    });

    if (!result.ok || !result.order) throw new Error(`test setup: handleSellTickets failed — ${JSON.stringify(result)}`);
    expect(result.order.totalCents).toBe(3000000);
    expect(result.order.items[0].unitPriceCents).toBe(3000000);
  });

  it("crossing a threshold mid-purchase charges every ticket at the tier active for it — buying up to the boundary, then one more, resolves independently per sale", async () => {
    const organization = await createTestOrganization();
    const buyer = await createTestUser();
    const event = await createTestEvent(organization.id, [
      { priceCents: 999, quantityTotal: 500, quantitySold: 99, pricingStrategy: "TIERED", pricingTiers: TIERS },
    ]);
    const ticketTypeId = event.ticketTypes[0].id;

    // 99 sold -> this sale is the 100th, still Early Bird (fromQuantity 0..99).
    const first = await handleSellTickets(buyer.id, {
      clientId: uniqueCode(),
      eventId: event.id,
      items: [{ ticketTypeId, quantity: 1, codes: [uniqueCode()] }],
    });
    if (!first.ok || !first.order) throw new Error("test setup failed");
    expect(first.order.totalCents).toBe(2000000);

    // Now 100 sold -> this next sale crosses into Standard.
    const second = await handleSellTickets(buyer.id, {
      clientId: uniqueCode(),
      eventId: event.id,
      items: [{ ticketTypeId, quantity: 1, codes: [uniqueCode()] }],
    });
    if (!second.ok || !second.order) throw new Error("test setup failed");
    expect(second.order.totalCents).toBe(3000000);
  });

  it("leaves FIXED-priced checkout unchanged", async () => {
    const organization = await createTestOrganization();
    const buyer = await createTestUser();
    const event = await createTestEvent(organization.id, [{ priceCents: 500000, quantityTotal: 10 }]);
    const ticketTypeId = event.ticketTypes[0].id;

    const result = await handleSellTickets(buyer.id, {
      clientId: uniqueCode(),
      eventId: event.id,
      items: [{ ticketTypeId, quantity: 2, codes: [uniqueCode(), uniqueCode()] }],
    });
    if (!result.ok || !result.order) throw new Error("test setup failed");
    expect(result.order.totalCents).toBe(1000000);
  });
});

describe("EDIT_EVENT payload schema", () => {
  it("does not strip pricingStrategy/pricingTiers off a ticket type — the wire-level guard against a Zod schema silently dropping unknown keys before handleEditEvent ever sees them", () => {
    const parsed = payloadSchemas.EDIT_EVENT.parse({
      eventId: "evt1",
      ticketTypes: [
        {
          id: "tt1",
          clientId: "local:tt1",
          name: "General Entry",
          priceCents: 2000000,
          quantityTotal: 500,
          pricingStrategy: "TIERED",
          pricingTiers: TIERS.map((t, i) => ({ clientId: `local:tier${i}`, ...t })),
        },
      ],
    });
    expect(parsed.ticketTypes?.[0].pricingStrategy).toBe("TIERED");
    expect(parsed.ticketTypes?.[0].pricingTiers).toHaveLength(3);
    expect(parsed.ticketTypes?.[0].pricingTiers?.[1]).toMatchObject({ fromQuantity: 100, priceCents: 3000000 });
  });
});

describe("organiser ticket-type edit — TIERED strategy and tiers persist", () => {
  it("persists pricingStrategy and tiers via the ticket type upsert loop, rejecting non-ascending tiers", async () => {
    const organization = await createTestOrganization();
    const owner = await createTestUser();
    const event = await createTestEvent(organization.id, [{ priceCents: 500000, quantityTotal: 100 }]);
    const tt = event.ticketTypes[0];

    // Directly exercise handleEditEvent's ticket-type payload shape, same
    // as the organiser's edit form submits.
    const { handleEditEvent } = await import("@/lib/sync-handlers");
    const rejected = await handleEditEvent(owner.id, organization.id, {
      eventId: event.id,
      ticketTypes: [
        {
          id: tt.id,
          name: tt.name,
          priceCents: tt.priceCents,
          quantityTotal: tt.quantityTotal,
          pricingStrategy: "TIERED",
          pricingTiers: [
            { clientId: uniqueCode(), fromQuantity: 100, priceCents: 3000000 },
            { clientId: uniqueCode(), fromQuantity: 0, priceCents: 2000000 },
          ],
        },
      ],
    });
    expect(rejected).toEqual({ ok: false, reason: "TIERS_NOT_ASCENDING_QUANTITY" });

    const accepted = await handleEditEvent(owner.id, organization.id, {
      eventId: event.id,
      ticketTypes: [
        {
          id: tt.id,
          name: tt.name,
          priceCents: tt.priceCents,
          quantityTotal: tt.quantityTotal,
          pricingStrategy: "TIERED",
          pricingTiers: TIERS.map((t) => ({ clientId: uniqueCode(), ...t })),
        },
      ],
    });
    expect(accepted.ok).toBe(true);

    const updated = await prisma.ticketType.findUnique({ where: { id: tt.id }, include: { pricingTiers: true } });
    expect(updated?.pricingStrategy).toBe("TIERED");
    expect(updated?.pricingTiers).toHaveLength(3);
  });
});
