import { describe, expect, it } from "vitest";
import { predictSellOut, forecastEventRevenue } from "./forecast";

const DAY = 24 * 60 * 60 * 1000;

describe("predictSellOut", () => {
  const ticketType = { id: "tt-1", name: "General", quantityTotal: 100, quantitySold: 40 };

  it("returns INSUFFICIENT_DATA with no sales history at all", () => {
    const now = new Date("2026-06-01");
    const result = predictSellOut(ticketType, [], new Date("2026-07-01"), now);
    expect(result.status).toBe("INSUFFICIENT_DATA");
    expect(result.predictedSoldOutDate).toBeNull();
  });

  it("returns INSUFFICIENT_DATA with fewer than 3 days of sale history", () => {
    const now = new Date("2026-06-03T12:00:00Z");
    const orderItems = [
      { createdAt: new Date("2026-06-02T10:00:00Z"), quantity: 5 },
      { createdAt: new Date("2026-06-03T10:00:00Z"), quantity: 5 },
    ];
    const result = predictSellOut(ticketType, orderItems, new Date("2026-07-01"), now);
    expect(result.status).toBe("INSUFFICIENT_DATA");
  });

  it("returns SOLD_OUT once quantitySold reaches quantityTotal, regardless of history", () => {
    const soldOut = { ...ticketType, quantitySold: 100 };
    const now = new Date("2026-06-01");
    const result = predictSellOut(soldOut, [], new Date("2026-07-01"), now);
    expect(result.status).toBe("SOLD_OUT");
  });

  it("returns SLOW when velocity is effectively zero despite having history", () => {
    // 3 distinct sale-days, but all sales happened long before the trailing
    // velocity window — so unitsInWindow is 0.
    const now = new Date("2026-06-20");
    const orderItems = [
      { createdAt: new Date("2026-05-01T10:00:00Z"), quantity: 5 },
      { createdAt: new Date("2026-05-02T10:00:00Z"), quantity: 5 },
      { createdAt: new Date("2026-05-03T10:00:00Z"), quantity: 5 },
    ];
    const result = predictSellOut(ticketType, orderItems, new Date("2026-07-01"), now);
    expect(result.status).toBe("SLOW");
  });

  it("returns LIKELY when the sale pace will exhaust remaining stock before the event", () => {
    // remaining = 60, selling ~10/day over the trailing window → sells out
    // in ~6 days, well before an event 30 days out.
    const now = new Date("2026-06-10T12:00:00Z");
    const orderItems = Array.from({ length: 5 }, (_, i) => ({
      createdAt: new Date(now.getTime() - i * DAY),
      quantity: 10,
    }));
    const result = predictSellOut(ticketType, orderItems, new Date("2026-07-10"), now);
    expect(result.status).toBe("LIKELY");
    expect(result.predictedSoldOutDate).not.toBeNull();
  });

  it("returns ON_TRACK when it will sell out, but only around/after the event date", () => {
    // remaining = 60, selling ~1/day → sells out in ~60 days, well past an
    // event only 10 days out.
    const now = new Date("2026-06-10T12:00:00Z");
    const orderItems = Array.from({ length: 5 }, (_, i) => ({
      createdAt: new Date(now.getTime() - i * DAY),
      quantity: 1,
    }));
    const result = predictSellOut(ticketType, orderItems, new Date("2026-06-20"), now);
    expect(result.status).toBe("ON_TRACK");
  });
});

describe("forecastEventRevenue", () => {
  it("returns an empty series for an event with no orders yet", () => {
    const result = forecastEventRevenue([], new Date("2026-07-01"), new Date("2026-06-01"));
    expect(result).toEqual([]);
  });

  it("never projects past the event's startsAt", () => {
    const now = new Date("2026-06-10T00:00:00Z");
    const orders = Array.from({ length: 5 }, (_, i) => ({
      createdAt: new Date(now.getTime() - i * DAY),
      totalCents: 100000,
    }));
    const eventStartsAt = new Date("2026-06-15T00:00:00Z"); // 5 days out
    const result = forecastEventRevenue(orders, eventStartsAt, now);

    const projected = result.filter((p) => p.projected);
    expect(projected.length).toBeGreaterThan(0);
    for (const p of projected) {
      expect(new Date(p.label).getTime()).toBeLessThan(eventStartsAt.getTime());
    }
  });

  it("caps the projected window at 30 days for a far-future event", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const orders = [{ createdAt: now, totalCents: 50000 }];
    const eventStartsAt = new Date("2027-01-01T00:00:00Z"); // far in the future
    const result = forecastEventRevenue(orders, eventStartsAt, now);
    const projected = result.filter((p) => p.projected);
    expect(projected.length).toBe(30);
  });

  it("adds no projected points once the event has already started", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const orders = [{ createdAt: new Date("2026-06-01"), totalCents: 50000 }];
    const eventStartsAt = new Date("2026-06-15T00:00:00Z"); // in the past relative to now
    const result = forecastEventRevenue(orders, eventStartsAt, now);
    expect(result.every((p) => !p.projected)).toBe(true);
    expect(result.length).toBeGreaterThan(0); // historical bars still shown
  });
});
