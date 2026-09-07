import { describe, expect, it } from "vitest";
import {
  TREND_WINDOW_DAYS,
  bucketByDay,
  bucketRevenueByDay,
  checkInRateByEvent,
  ticketTypeSellThrough,
  summarizeVendors,
  topOrganizersByRevenue,
  topEventsByTicketsSold,
  summarizeWalletBalances,
  summarizeWalletActivity,
  spendByVendor,
  sponsorTapsBySponsor,
  customerStatsByBuyer,
  checkInsByHour,
  transactionsByVendorByHour,
  liveEventStats,
} from "./analytics";

describe("bucketByDay", () => {
  it("zero-fills every day in the window, even with no activity at all", () => {
    const series = bucketByDay([], () => new Date(), () => 1);
    expect(series).toHaveLength(TREND_WINDOW_DAYS);
    expect(series.every((p) => p.value === 0)).toBe(true);
  });

  it("aggregates multiple rows landing on the same day", () => {
    const today = new Date();
    const rows = [{ at: today, n: 3 }, { at: today, n: 4 }];
    const series = bucketByDay(rows, (r) => r.at, (r) => r.n);
    const last = series[series.length - 1];
    expect(last.value).toBe(7);
  });

  it("respects a custom window length", () => {
    const series = bucketByDay([], () => new Date(), () => 1, 7);
    expect(series).toHaveLength(7);
  });
});

describe("bucketRevenueByDay", () => {
  it("never mixes revenue across currencies into one series", () => {
    const today = new Date();
    const orders = [
      { createdAt: today, totalCents: 100000, currency: "TZS" },
      { createdAt: today, totalCents: 6500, currency: "USD" },
    ];
    const byCurrency = bucketRevenueByDay(orders);
    expect(Object.keys(byCurrency).sort()).toEqual(["TZS", "USD"]);
    expect(byCurrency.TZS[byCurrency.TZS.length - 1].value).toBe(100000);
    expect(byCurrency.USD[byCurrency.USD.length - 1].value).toBe(6500);
  });

  it("returns an empty object for no orders — not a zero-value TZS series", () => {
    expect(bucketRevenueByDay([])).toEqual({});
  });
});

describe("checkInRateByEvent", () => {
  it("computes a per-event percentage from raw ticket rows", () => {
    const tickets = [
      { eventId: "e1", checkedIn: true },
      { eventId: "e1", checkedIn: true },
      { eventId: "e1", checkedIn: false },
      { eventId: "e1", checkedIn: false },
    ];
    const stats = checkInRateByEvent(tickets, [{ id: "e1", title: "Bongo Beats" }]);
    expect(stats).toEqual([{ eventId: "e1", title: "Bongo Beats", checkedIn: 2, total: 4, pct: 50 }]);
  });

  it("omits events with zero tickets rather than showing a misleading 0%", () => {
    const stats = checkInRateByEvent([], [{ id: "e1", title: "No Sales Yet" }]);
    expect(stats).toEqual([]);
  });
});

describe("ticketTypeSellThrough", () => {
  it("ranks ticket types by sell-through percentage, highest first", () => {
    const ranked = ticketTypeSellThrough([
      { id: "tt1", name: "VIP", quantitySold: 8, quantityTotal: 10, event: { title: "E" } },
      { id: "tt2", name: "General", quantitySold: 1, quantityTotal: 10, event: { title: "E" } },
    ]);
    expect(ranked.map((r) => r.ticketTypeId)).toEqual(["tt1", "tt2"]);
    expect(ranked[0].pct).toBe(80);
  });

  it("guards against divide-by-zero when quantityTotal is 0", () => {
    const ranked = ticketTypeSellThrough([
      { id: "tt1", name: "Free RSVP", quantitySold: 0, quantityTotal: 0, event: { title: "E" } },
    ]);
    expect(ranked[0].pct).toBe(0);
  });
});

describe("summarizeVendors", () => {
  it("counts by status and sums fee revenue only for PAID vendors, by currency", () => {
    const stats = summarizeVendors([
      { status: "APPROVED", feeStatus: "PAID", stallFeeCents: 1500000, currency: "TZS" },
      { status: "APPROVED", feeStatus: "NONE", stallFeeCents: 0, currency: "TZS" },
      { status: "REJECTED", feeStatus: "REFUNDED", stallFeeCents: 1000000, currency: "TZS" },
      // Fees are charged at application time (before approval), so a still-
      // pending vendor who already paid genuinely counts as revenue collected.
      { status: "PENDING", feeStatus: "PAID", stallFeeCents: 500000, currency: "TZS" },
    ]);
    expect(stats.applications).toBe(4);
    expect(stats.approved).toBe(2);
    expect(stats.rejected).toBe(1);
    expect(stats.pending).toBe(1);
    expect(stats.approvalRatePct).toBe(67); // 2 of 3 decided, rounded
    // Refunded fees (from the rejected vendor) don't count as revenue collected.
    expect(stats.feeRevenueByCurrency).toEqual({ TZS: 2000000 });
  });

  it("returns null approvalRatePct rather than a misleading 0% when nothing's been decided", () => {
    const stats = summarizeVendors([
      { status: "PENDING", feeStatus: "NONE", stallFeeCents: 0, currency: "TZS" },
    ]);
    expect(stats.approvalRatePct).toBeNull();
  });

  it("handles zero vendors cleanly", () => {
    const stats = summarizeVendors([]);
    expect(stats.applications).toBe(0);
    expect(stats.approvalRatePct).toBeNull();
    expect(stats.feeRevenueByCurrency).toEqual({});
  });
});

describe("topOrganizersByRevenue", () => {
  it("ranks organizations within each currency separately, never mixed", () => {
    const orders = [
      { totalCents: 500000, currency: "TZS", event: { organizationId: "o1", organization: { name: "Nova Events Co." } } },
      { totalCents: 200000, currency: "TZS", event: { organizationId: "o2", organization: { name: "Skyline Presents" } } },
      { totalCents: 6500, currency: "USD", event: { organizationId: "o2", organization: { name: "Skyline Presents" } } },
    ];
    const byCurrency = topOrganizersByRevenue(orders);
    expect(byCurrency.TZS[0]).toEqual({ label: "Nova Events Co.", value: 500000 });
    expect(byCurrency.USD).toEqual([{ label: "Skyline Presents", value: 6500 }]);
  });

  it("respects the limit", () => {
    const orders = Array.from({ length: 8 }, (_, i) => ({
      totalCents: 1000 * (i + 1),
      currency: "TZS",
      event: { organizationId: `o${i}`, organization: { name: `Org ${i}` } },
    }));
    const byCurrency = topOrganizersByRevenue(orders, 3);
    expect(byCurrency.TZS).toHaveLength(3);
    expect(byCurrency.TZS[0].value).toBe(8000);
  });
});

describe("topEventsByTicketsSold", () => {
  it("sums quantitySold per event across its ticket types and ranks them", () => {
    const ranked = topEventsByTicketsSold([
      { quantitySold: 10, event: { id: "e1", title: "Bongo Beats" } },
      { quantitySold: 5, event: { id: "e1", title: "Bongo Beats" } },
      { quantitySold: 3, event: { id: "e2", title: "Comedy Night" } },
    ]);
    expect(ranked[0]).toEqual({ label: "Bongo Beats", value: 15 });
    expect(ranked[1]).toEqual({ label: "Comedy Night", value: 3 });
  });
});

describe("summarizeWalletBalances", () => {
  it("sums outstanding balance by currency and counts wallets", () => {
    const stats = summarizeWalletBalances([
      { balanceCents: 5000, currency: "TZS" },
      { balanceCents: 3000, currency: "TZS" },
      { balanceCents: 1000, currency: "USD" },
    ]);
    expect(stats.walletCount).toBe(3);
    expect(stats.outstandingBalanceByCurrency).toEqual({ TZS: 8000, USD: 1000 });
  });

  it("handles zero wallets cleanly", () => {
    const stats = summarizeWalletBalances([]);
    expect(stats.walletCount).toBe(0);
    expect(stats.outstandingBalanceByCurrency).toEqual({});
  });
});

describe("summarizeWalletActivity", () => {
  it("only counts COMPLETED top-ups and sales toward volume, by currency", () => {
    const stats = summarizeWalletActivity([
      { type: "TOPUP", status: "COMPLETED", amountCents: 5000, currency: "TZS" },
      { type: "TOPUP", status: "PENDING", amountCents: 2000, currency: "TZS" },
      { type: "SALE", status: "COMPLETED", amountCents: 1500, currency: "TZS" },
      { type: "SALE", status: "FAILED", amountCents: 9999, currency: "TZS" },
      { type: "SPONSOR_TAP", status: "COMPLETED", amountCents: null, currency: "TZS" },
      { type: "SPONSOR_TAP", status: "COMPLETED", amountCents: null, currency: "TZS" },
    ]);
    expect(stats.topupVolumeByCurrency).toEqual({ TZS: 5000 });
    expect(stats.spendVolumeByCurrency).toEqual({ TZS: 1500 });
    expect(stats.sponsorTapCount).toBe(2);
  });

  it("handles zero activity cleanly", () => {
    const stats = summarizeWalletActivity([]);
    expect(stats.topupVolumeByCurrency).toEqual({});
    expect(stats.spendVolumeByCurrency).toEqual({});
    expect(stats.sponsorTapCount).toBe(0);
  });
});

describe("spendByVendor", () => {
  it("ranks vendors by completed sale volume, one list per currency", () => {
    const byCurrency = spendByVendor([
      { type: "SALE", status: "COMPLETED", amountCents: 3000, currency: "TZS", vendor: { id: "v1", name: "Spice Grill" } },
      { type: "SALE", status: "COMPLETED", amountCents: 1000, currency: "TZS", vendor: { id: "v2", name: "Coconut Water" } },
      { type: "SALE", status: "FAILED", amountCents: 9999, currency: "TZS", vendor: { id: "v1", name: "Spice Grill" } },
      { type: "TOPUP", status: "COMPLETED", amountCents: 5000, currency: "TZS", vendor: null },
    ]);
    expect(byCurrency.TZS[0]).toEqual({ label: "Spice Grill", value: 3000 });
    expect(byCurrency.TZS[1]).toEqual({ label: "Coconut Water", value: 1000 });
  });

  it("returns an empty object for no sales", () => {
    expect(spendByVendor([])).toEqual({});
  });
});

describe("sponsorTapsBySponsor", () => {
  it("counts taps per sponsor and ranks them", () => {
    const ranked = sponsorTapsBySponsor([
      { type: "SPONSOR_TAP", sponsor: { id: "s1", name: "Red Bull Stage" } },
      { type: "SPONSOR_TAP", sponsor: { id: "s1", name: "Red Bull Stage" } },
      { type: "SPONSOR_TAP", sponsor: { id: "s2", name: "MTN Booth" } },
      { type: "SALE", sponsor: null },
    ]);
    expect(ranked[0]).toEqual({ label: "Red Bull Stage", value: 2 });
    expect(ranked[1]).toEqual({ label: "MTN Booth", value: 1 });
  });
});

describe("customerStatsByBuyer", () => {
  it("keeps totals separate per currency for the same buyer", () => {
    const stats = customerStatsByBuyer([
      { userId: "u1", user: { name: "Amina", email: "amina@test.local" }, totalCents: 100000, currency: "TZS", createdAt: new Date("2026-08-01") },
      { userId: "u1", user: { name: "Amina", email: "amina@test.local" }, totalCents: 5000, currency: "USD", createdAt: new Date("2026-08-02") },
    ]);
    expect(stats).toHaveLength(1);
    expect(stats[0].totalCentsByCurrency).toEqual({ TZS: 100000, USD: 5000 });
  });

  it("aggregates ordersCount and sums totals across multiple orders from the same buyer", () => {
    const stats = customerStatsByBuyer([
      { userId: "u1", user: { name: "Amina", email: "amina@test.local" }, totalCents: 100000, currency: "TZS", createdAt: new Date("2026-08-01") },
      { userId: "u1", user: { name: "Amina", email: "amina@test.local" }, totalCents: 50000, currency: "TZS", createdAt: new Date("2026-08-03") },
    ]);
    expect(stats[0].ordersCount).toBe(2);
    expect(stats[0].totalCentsByCurrency).toEqual({ TZS: 150000 });
  });

  it("picks the max createdAt across orders as lastOrderAt, regardless of input order", () => {
    const stats = customerStatsByBuyer([
      { userId: "u1", user: { name: "Amina", email: "amina@test.local" }, totalCents: 100000, currency: "TZS", createdAt: new Date("2026-08-01") },
      { userId: "u1", user: { name: "Amina", email: "amina@test.local" }, totalCents: 50000, currency: "TZS", createdAt: new Date("2026-08-10") },
      { userId: "u1", user: { name: "Amina", email: "amina@test.local" }, totalCents: 25000, currency: "TZS", createdAt: new Date("2026-08-05") },
    ]);
    expect(stats[0].lastOrderAt).toEqual(new Date("2026-08-10"));
  });

  it("keeps different buyers as separate entries", () => {
    const stats = customerStatsByBuyer([
      { userId: "u1", user: { name: "Amina", email: "amina@test.local" }, totalCents: 100000, currency: "TZS", createdAt: new Date("2026-08-01") },
      { userId: "u2", user: { name: "Baraka", email: "baraka@test.local" }, totalCents: 50000, currency: "TZS", createdAt: new Date("2026-08-02") },
    ]);
    expect(stats.map((s) => s.userId).sort()).toEqual(["u1", "u2"]);
  });
});

describe("checkInsByHour", () => {
  it("zero-fills every hour from event start through now, even with no check-ins", () => {
    const series = checkInsByHour([], new Date("2026-08-01T09:00:00"), new Date("2026-08-01T11:30:00"));
    expect(series.map((p) => p.hour)).toEqual(["09:00", "10:00", "11:00"]);
    expect(series.every((p) => p.count === 0 && p.cumulative === 0)).toBe(true);
  });

  it("buckets check-ins by hour and carries a running cumulative total forward", () => {
    const tickets = [
      { checkedInAt: new Date("2026-08-01T09:15:00") },
      { checkedInAt: new Date("2026-08-01T09:45:00") },
      { checkedInAt: new Date("2026-08-01T10:30:00") },
    ];
    const series = checkInsByHour(tickets, new Date("2026-08-01T09:00:00"), new Date("2026-08-01T11:30:00"));
    expect(series).toEqual([
      { hour: "09:00", count: 2, cumulative: 2 },
      { hour: "10:00", count: 1, cumulative: 3 },
      { hour: "11:00", count: 0, cumulative: 3 },
    ]);
  });

  it("ignores tickets that haven't checked in yet", () => {
    const tickets = [{ checkedInAt: null }, { checkedInAt: new Date("2026-08-01T09:10:00") }];
    const series = checkInsByHour(tickets, new Date("2026-08-01T09:00:00"), new Date("2026-08-01T09:30:00"));
    expect(series).toEqual([{ hour: "09:00", count: 1, cumulative: 1 }]);
  });
});

describe("transactionsByVendorByHour", () => {
  it("returns nothing for no transactions", () => {
    const rows = transactionsByVendorByHour([], new Date("2026-08-01T09:00:00"), new Date("2026-08-01T10:30:00"));
    expect(rows).toEqual([]);
  });

  it("buckets completed SALE transactions by vendor and by hour, ignoring other types/statuses, with every vendor sharing the same zero-filled hour columns", () => {
    const txs = [
      { type: "SALE", status: "COMPLETED", amountCents: 1000, createdAt: new Date("2026-08-01T09:20:00"), vendor: { id: "v1", name: "Spice Grill" } },
      { type: "SALE", status: "COMPLETED", amountCents: 500, createdAt: new Date("2026-08-01T09:50:00"), vendor: { id: "v1", name: "Spice Grill" } },
      { type: "SALE", status: "COMPLETED", amountCents: 2000, createdAt: new Date("2026-08-01T10:10:00"), vendor: { id: "v2", name: "Coconut Water" } },
      { type: "SALE", status: "FAILED", amountCents: 9999, createdAt: new Date("2026-08-01T09:25:00"), vendor: { id: "v1", name: "Spice Grill" } },
      { type: "TOPUP", status: "COMPLETED", amountCents: 5000, createdAt: new Date("2026-08-01T09:30:00"), vendor: null },
    ];
    const rows = transactionsByVendorByHour(txs, new Date("2026-08-01T09:00:00"), new Date("2026-08-01T10:30:00"));

    const spiceGrill = rows.find((r) => r.vendorName === "Spice Grill")!;
    const coconutWater = rows.find((r) => r.vendorName === "Coconut Water")!;
    expect(spiceGrill.hours).toEqual([
      { hour: "09:00", count: 2, amountCents: 1500 },
      { hour: "10:00", count: 0, amountCents: 0 },
    ]);
    expect(coconutWater.hours).toEqual([
      { hour: "09:00", count: 0, amountCents: 0 },
      { hour: "10:00", count: 1, amountCents: 2000 },
    ]);
  });
});

describe("liveEventStats", () => {
  it("computes check-in, capacity, wallet, and active-vendor stats from raw rows", () => {
    const now = new Date("2026-08-01T12:00:00");
    const tickets = [
      { checkedIn: true, checkedInAt: new Date("2026-08-01T11:50:00") }, // within last 30 min
      { checkedIn: true, checkedInAt: new Date("2026-08-01T09:00:00") }, // checked in, but not recent
      { checkedIn: false, checkedInAt: null },
    ];
    const ticketTypes = [{ quantityTotal: 100 }, { quantityTotal: 50 }];
    const wallets = [{ balanceCents: 3000 }, { balanceCents: 2000 }];
    const walletTxs = [
      { type: "TOPUP", status: "COMPLETED", amountCents: 5000, createdAt: new Date("2026-08-01T10:00:00"), vendorId: null },
      { type: "TOPUP", status: "PENDING", amountCents: 9999, createdAt: new Date("2026-08-01T10:00:00"), vendorId: null },
      { type: "SALE", status: "COMPLETED", amountCents: 1500, createdAt: new Date("2026-08-01T11:30:00"), vendorId: "v1" }, // within last 60 min
      { type: "SALE", status: "COMPLETED", amountCents: 800, createdAt: new Date("2026-08-01T09:00:00"), vendorId: "v2" }, // not recent
      { type: "SALE", status: "FAILED", amountCents: 9999, createdAt: new Date("2026-08-01T11:45:00"), vendorId: "v3" },
    ];

    const stats = liveEventStats(tickets, ticketTypes, wallets, walletTxs, now);
    expect(stats).toEqual({
      totalCheckedIn: 2,
      capacityTotal: 150,
      checkInsLast30Min: 1,
      totalTopUpCents: 5000,
      totalSpendCents: 2300,
      unspentBalanceCents: 5000,
      activeVendorCount: 1,
      lastUpdated: now,
    });
  });

  it("handles zero data cleanly", () => {
    const now = new Date("2026-08-01T12:00:00");
    const stats = liveEventStats([], [], [], [], now);
    expect(stats).toEqual({
      totalCheckedIn: 0,
      capacityTotal: 0,
      checkInsLast30Min: 0,
      totalTopUpCents: 0,
      totalSpendCents: 0,
      unspentBalanceCents: 0,
      activeVendorCount: 0,
      lastUpdated: now,
    });
  });
});
