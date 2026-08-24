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
  it("ranks organizers within each currency separately, never mixed", () => {
    const orders = [
      { totalCents: 500000, currency: "TZS", event: { organizerId: "u1", organizer: { name: "Nova Events Co." } } },
      { totalCents: 200000, currency: "TZS", event: { organizerId: "u2", organizer: { name: "Skyline Presents" } } },
      { totalCents: 6500, currency: "USD", event: { organizerId: "u2", organizer: { name: "Skyline Presents" } } },
    ];
    const byCurrency = topOrganizersByRevenue(orders);
    expect(byCurrency.TZS[0]).toEqual({ label: "Nova Events Co.", value: 500000 });
    expect(byCurrency.USD).toEqual([{ label: "Skyline Presents", value: 6500 }]);
  });

  it("respects the limit", () => {
    const orders = Array.from({ length: 8 }, (_, i) => ({
      totalCents: 1000 * (i + 1),
      currency: "TZS",
      event: { organizerId: `u${i}`, organizer: { name: `Org ${i}` } },
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
