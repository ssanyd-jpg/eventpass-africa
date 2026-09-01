import { describe, expect, it } from "vitest";
import { bandFromScore, scoreOrderRisk, scoreVendorRisk, type OrderRiskRow, type VendorRiskRow } from "./risk";

describe("bandFromScore", () => {
  it("bands at the exact 29/30 boundary", () => {
    expect(bandFromScore(29)).toBe("LOW");
    expect(bandFromScore(30)).toBe("MEDIUM");
  });

  it("bands at the exact 69/70 boundary", () => {
    expect(bandFromScore(69)).toBe("MEDIUM");
    expect(bandFromScore(70)).toBe("HIGH");
  });

  it("bands 0 as LOW and 100 as HIGH", () => {
    expect(bandFromScore(0)).toBe("LOW");
    expect(bandFromScore(100)).toBe("HIGH");
  });
});

const BASE_TIME = new Date("2026-06-01T12:00:00Z").getTime();
const MIN = 60 * 1000;

function order(overrides: Partial<OrderRiskRow> & { id: string }): OrderRiskRow {
  return {
    userId: "buyer-1",
    status: "PAID",
    discountCode: null,
    createdAt: new Date(BASE_TIME).toISOString(),
    ticketCount: 1,
    eventId: "event-1",
    ...overrides,
  };
}

describe("scoreOrderRisk", () => {
  it("scores a single ordinary order as LOW with no reasons", () => {
    const o = order({ id: "o1" });
    const result = scoreOrderRisk(o, { allOrders: [o] });
    expect(result.band).toBe("LOW");
    expect(result.score).toBe(0);
    expect(result.reasons).toHaveLength(0);
  });

  it("scores higher for a buyer with a high refund rate", () => {
    const orders = [
      order({ id: "o1", userId: "b1", status: "REFUNDED" }),
      order({ id: "o2", userId: "b1", status: "REFUNDED" }),
      order({ id: "o3", userId: "b1", status: "PAID" }),
    ];
    const result = scoreOrderRisk(orders[2], { allOrders: orders });
    expect(result.score).toBeGreaterThan(0);
    expect(result.reasons.some((r) => r.includes("refunded"))).toBe(true);
  });

  it("scores a large order from a brand-new account as elevated risk", () => {
    const o = order({
      id: "o1",
      ticketCount: 10,
      createdAt: new Date(BASE_TIME).toISOString(),
      userCreatedAt: new Date(BASE_TIME - 5 * MIN).toISOString(),
    });
    const result = scoreOrderRisk(o, { allOrders: [o] });
    expect(result.score).toBeGreaterThanOrEqual(20);
  });

  it("does not penalize a small order from a brand-new account", () => {
    const o = order({
      id: "o1",
      ticketCount: 1,
      createdAt: new Date(BASE_TIME).toISOString(),
      userCreatedAt: new Date(BASE_TIME - 5 * MIN).toISOString(),
    });
    const result = scoreOrderRisk(o, { allOrders: [o] });
    expect(result.score).toBe(0);
  });

  it("combines multiple signals into a single higher score than any signal alone", () => {
    const discountBurst = Array.from({ length: 6 }, (_, i) =>
      order({ id: `burst-${i}`, discountCode: "SAVE10", userId: `other-${i}`, createdAt: new Date(BASE_TIME + i * MIN).toISOString() })
    );
    const risky = order({
      id: "target",
      discountCode: "SAVE10",
      userId: "risky-buyer",
      createdAt: new Date(BASE_TIME + 6 * MIN).toISOString(),
      ticketCount: 10,
      userCreatedAt: new Date(BASE_TIME + 6 * MIN - 5 * MIN).toISOString(),
    });
    const allOrders = [...discountBurst, risky];
    const result = scoreOrderRisk(risky, { allOrders });
    expect(result.score).toBeGreaterThan(30);
    expect(result.reasons.length).toBeGreaterThan(1);
  });

  it("caps the total score at 100", () => {
    // Contrive an extreme combination — every signal maxed.
    const burst = Array.from({ length: 10 }, (_, i) =>
      order({ id: `b${i}`, discountCode: "X", userId: `u${i}`, createdAt: new Date(BASE_TIME + i * 30 * 1000).toISOString() })
    );
    const refunded = [
      order({ id: "r1", userId: "risky", status: "REFUNDED", createdAt: new Date(BASE_TIME).toISOString() }),
      order({ id: "r2", userId: "risky", status: "REFUNDED", createdAt: new Date(BASE_TIME).toISOString() }),
    ];
    const target = order({
      id: "target",
      discountCode: "X",
      userId: "risky",
      createdAt: new Date(BASE_TIME + 9 * 30 * 1000).toISOString(),
      ticketCount: 20,
      userCreatedAt: new Date(BASE_TIME).toISOString(),
    });
    const allOrders = [...burst, ...refunded, target];
    const result = scoreOrderRisk(target, { allOrders });
    expect(result.score).toBeLessThanOrEqual(100);
  });
});

describe("scoreVendorRisk", () => {
  function vendor(overrides: Partial<VendorRiskRow> & { id: string }): VendorRiskRow {
    return {
      contactEmail: "a@test.local",
      contactPhone: "12345",
      description: "We sell snacks.",
      ownerUserId: null,
      createdAt: new Date(BASE_TIME).toISOString(),
      ...overrides,
    };
  }

  it("scores a complete, unique application as LOW with no reasons", () => {
    const v = vendor({ id: "v1" });
    const result = scoreVendorRisk(v, { allVendors: [v] });
    expect(result.band).toBe("LOW");
    expect(result.reasons).toHaveLength(0);
  });

  it("scores a duplicate-contact application as elevated risk", () => {
    const v1 = vendor({ id: "v1", contactEmail: "shared@test.local" });
    const v2 = vendor({ id: "v2", contactEmail: "shared@test.local" });
    const result = scoreVendorRisk(v2, { allVendors: [v1, v2] });
    expect(result.score).toBeGreaterThanOrEqual(40);
    expect(result.band).not.toBe("LOW");
  });

  it("scores a blank-profile application (no description, no phone) as elevated risk", () => {
    const v = vendor({ id: "v1", description: "", contactPhone: "" });
    const result = scoreVendorRisk(v, { allVendors: [v] });
    expect(result.score).toBeGreaterThanOrEqual(25);
  });

  it("does not penalize a blank description alone if a phone number is present", () => {
    const v = vendor({ id: "v1", description: "" });
    const result = scoreVendorRisk(v, { allVendors: [v] });
    expect(result.score).toBe(0);
  });
});
