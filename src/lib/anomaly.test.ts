import { describe, expect, it } from "vitest";
import {
  detectOrderAnomalies,
  detectVendorAnomalies,
  detectCampaignRedemptionAnomalies,
  type OrderAnomalyRow,
  type VendorAnomalyRow,
  type CampaignRedemptionRow,
} from "./anomaly";

const BASE_TIME = new Date("2026-06-01T12:00:00Z").getTime();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function order(overrides: Partial<OrderAnomalyRow> & { id: string }): OrderAnomalyRow {
  return {
    userId: "buyer-1",
    status: "PAID",
    discountCode: null,
    createdAt: new Date(BASE_TIME).toISOString(),
    ticketCount: 1,
    ...overrides,
  };
}

describe("detectOrderAnomalies — DISCOUNT_VELOCITY", () => {
  it("does not flag 4 redemptions of the same code within the window", () => {
    const orders = Array.from({ length: 4 }, (_, i) =>
      order({ id: `o${i}`, discountCode: "SAVE10", createdAt: new Date(BASE_TIME + i * MIN).toISOString() })
    );
    const flags = detectOrderAnomalies(orders);
    expect(flags.filter((f) => f.code === "DISCOUNT_VELOCITY")).toHaveLength(0);
  });

  it("flags exactly at the 5th redemption within 10 minutes", () => {
    const orders = Array.from({ length: 5 }, (_, i) =>
      order({ id: `o${i}`, discountCode: "SAVE10", createdAt: new Date(BASE_TIME + i * MIN).toISOString() })
    );
    const flags = detectOrderAnomalies(orders);
    expect(flags.filter((f) => f.code === "DISCOUNT_VELOCITY")).toHaveLength(1);
    expect(flags[0].relatedId).toBe("o4");
  });

  it("does not flag 5 redemptions of the same code spread beyond 10 minutes", () => {
    const orders = Array.from({ length: 5 }, (_, i) =>
      order({ id: `o${i}`, discountCode: "SAVE10", createdAt: new Date(BASE_TIME + i * 5 * MIN).toISOString() })
    );
    const flags = detectOrderAnomalies(orders);
    expect(flags.filter((f) => f.code === "DISCOUNT_VELOCITY")).toHaveLength(0);
  });

  it("ignores orders with no discount code", () => {
    const orders = Array.from({ length: 6 }, (_, i) => order({ id: `o${i}`, createdAt: new Date(BASE_TIME + i * MIN).toISOString() }));
    expect(detectOrderAnomalies(orders)).toHaveLength(0);
  });
});

describe("detectOrderAnomalies — REFUND_RATE", () => {
  it("does not flag a buyer with exactly 50% refunded", () => {
    const orders = [
      order({ id: "o1", userId: "b1", status: "REFUNDED" }),
      order({ id: "o2", userId: "b1", status: "PAID" }),
    ];
    // Only 2 orders — below REFUND_RATE_MIN_ORDERS (3), so no flag regardless of rate.
    expect(detectOrderAnomalies(orders).filter((f) => f.code === "REFUND_RATE")).toHaveLength(0);
  });

  it("flags every order from a buyer whose refund rate exceeds 50% across >=3 orders", () => {
    const orders = [
      order({ id: "o1", userId: "b1", status: "REFUNDED" }),
      order({ id: "o2", userId: "b1", status: "REFUNDED" }),
      order({ id: "o3", userId: "b1", status: "PAID" }),
    ];
    const flags = detectOrderAnomalies(orders).filter((f) => f.code === "REFUND_RATE");
    expect(flags).toHaveLength(3);
  });

  it("does not flag a buyer at exactly 50% refunded with 4 orders", () => {
    const orders = [
      order({ id: "o1", userId: "b1", status: "REFUNDED" }),
      order({ id: "o2", userId: "b1", status: "REFUNDED" }),
      order({ id: "o3", userId: "b1", status: "PAID" }),
      order({ id: "o4", userId: "b1", status: "PAID" }),
    ];
    expect(detectOrderAnomalies(orders).filter((f) => f.code === "REFUND_RATE")).toHaveLength(0);
  });
});

describe("detectOrderAnomalies — NEW_ACCOUNT_LARGE_ORDER", () => {
  it("flags a 10-ticket order from an account created 30 minutes earlier", () => {
    const orders = [
      order({
        id: "o1",
        ticketCount: 10,
        createdAt: new Date(BASE_TIME).toISOString(),
        userCreatedAt: new Date(BASE_TIME - 30 * MIN).toISOString(),
      }),
    ];
    const flags = detectOrderAnomalies(orders);
    expect(flags.some((f) => f.code === "NEW_ACCOUNT_LARGE_ORDER")).toBe(true);
  });

  it("does not flag a 9-ticket order from a brand-new account", () => {
    const orders = [
      order({
        id: "o1",
        ticketCount: 9,
        createdAt: new Date(BASE_TIME).toISOString(),
        userCreatedAt: new Date(BASE_TIME - 1 * MIN).toISOString(),
      }),
    ];
    expect(detectOrderAnomalies(orders).filter((f) => f.code === "NEW_ACCOUNT_LARGE_ORDER")).toHaveLength(0);
  });

  it("does not flag a 10-ticket order from an account created 2 hours earlier", () => {
    const orders = [
      order({
        id: "o1",
        ticketCount: 10,
        createdAt: new Date(BASE_TIME).toISOString(),
        userCreatedAt: new Date(BASE_TIME - 2 * HOUR).toISOString(),
      }),
    ];
    expect(detectOrderAnomalies(orders).filter((f) => f.code === "NEW_ACCOUNT_LARGE_ORDER")).toHaveLength(0);
  });
});

describe("detectVendorAnomalies", () => {
  function vendor(overrides: Partial<VendorAnomalyRow> & { id: string }): VendorAnomalyRow {
    return {
      contactEmail: "",
      contactPhone: "",
      ownerUserId: null,
      createdAt: new Date(BASE_TIME).toISOString(),
      ...overrides,
    };
  }

  it("flags two applications sharing the same contact email", () => {
    const vendors = [
      vendor({ id: "v1", contactEmail: "a@test.local" }),
      vendor({ id: "v2", contactEmail: "a@test.local" }),
    ];
    const flags = detectVendorAnomalies(vendors).filter((f) => f.code === "CONTACT_DUPLICATE");
    expect(flags).toHaveLength(2);
  });

  it("does not flag two applications with different contact info", () => {
    const vendors = [
      vendor({ id: "v1", contactEmail: "a@test.local", contactPhone: "111" }),
      vendor({ id: "v2", contactEmail: "b@test.local", contactPhone: "222" }),
    ];
    expect(detectVendorAnomalies(vendors).filter((f) => f.code === "CONTACT_DUPLICATE")).toHaveLength(0);
  });

  it("does not flag empty contact fields as duplicates of each other", () => {
    const vendors = [vendor({ id: "v1" }), vendor({ id: "v2" })];
    expect(detectVendorAnomalies(vendors).filter((f) => f.code === "CONTACT_DUPLICATE")).toHaveLength(0);
  });

  it("flags application velocity above the threshold from the same owner within 24h", () => {
    const vendors = Array.from({ length: 5 }, (_, i) =>
      vendor({ id: `v${i}`, ownerUserId: "owner-1", createdAt: new Date(BASE_TIME + i * HOUR).toISOString() })
    );
    const flags = detectVendorAnomalies(vendors).filter((f) => f.code === "APPLICATION_VELOCITY");
    expect(flags.length).toBeGreaterThan(0);
  });

  it("does not flag 4 applications (at the threshold, not above it) from the same owner within 24h", () => {
    const vendors = Array.from({ length: 4 }, (_, i) =>
      vendor({ id: `v${i}`, ownerUserId: "owner-1", createdAt: new Date(BASE_TIME + i * HOUR).toISOString() })
    );
    expect(detectVendorAnomalies(vendors).filter((f) => f.code === "APPLICATION_VELOCITY")).toHaveLength(0);
  });
});

describe("detectCampaignRedemptionAnomalies", () => {
  function redemption(overrides: Partial<CampaignRedemptionRow> & { id: string }): CampaignRedemptionRow {
    return { campaignId: "camp-1", walletId: "wallet-1", createdAt: new Date(BASE_TIME).toISOString(), ...overrides };
  }

  it("flags a burst of 5 distinct wallets redeeming the same campaign within 10 minutes", () => {
    const redemptions = Array.from({ length: 5 }, (_, i) =>
      redemption({ id: `r${i}`, walletId: `wallet-${i}`, createdAt: new Date(BASE_TIME + i * MIN).toISOString() })
    );
    const flags = detectCampaignRedemptionAnomalies(redemptions);
    expect(flags.some((f) => f.code === "CAMPAIGN_REDEMPTION_BURST")).toBe(true);
  });

  it("does not flag the same wallet redeeming repeatedly (already blocked elsewhere) as a burst", () => {
    const redemptions = Array.from({ length: 5 }, (_, i) =>
      redemption({ id: `r${i}`, walletId: "wallet-1", createdAt: new Date(BASE_TIME + i * MIN).toISOString() })
    );
    // Only 1 distinct wallet — not a coordinated multi-wallet burst.
    expect(detectCampaignRedemptionAnomalies(redemptions)).toHaveLength(0);
  });

  it("does not flag 4 distinct wallets (below the threshold)", () => {
    const redemptions = Array.from({ length: 4 }, (_, i) =>
      redemption({ id: `r${i}`, walletId: `wallet-${i}`, createdAt: new Date(BASE_TIME + i * MIN).toISOString() })
    );
    expect(detectCampaignRedemptionAnomalies(redemptions)).toHaveLength(0);
  });
});
