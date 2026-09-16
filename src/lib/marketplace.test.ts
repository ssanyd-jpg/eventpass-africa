import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestEvent, createTestOrganization, createTestUser, addMembership, createTestWallet } from "@/lib/test-fixtures";
import {
  computeEventPricing,
  getPublicEvents,
  getFeaturedEvents,
  getPublicEventCities,
  getPublishedEventSlugs,
  getPlatformStats,
  EVENTS_PAGE_SIZE,
} from "@/lib/marketplace";

// Same reasoning as reminders.test.ts: NotificationLog/Event/TicketType rows
// pile up forever in this shared, never-cleaned-up test database, and
// createTestEvent's default startsAt ("+24h" from the real clock) means a
// real-clock query here would also match every other test file's own
// fixture events created moments earlier or later in the same run. Each
// test gets its own far-future, non-overlapping time window (100 days
// apart) so its startsAt-range queries only ever see its own fixtures,
// regardless of how large the shared tables grow.
const FAR_FUTURE_BASE = Date.now() + 5000 * 24 * 60 * 60 * 1000;
let anchorOffsetDays = 0;
function nextAnchor(): Date {
  anchorOffsetDays += 100;
  return new Date(FAR_FUTURE_BASE + anchorOffsetDays * 24 * 60 * 60 * 1000);
}

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { organizationId: organization.id };
}

// createTestEvent has no title/city/eventType/status/startsAt overrides, so
// every event here is created then moved to the exact fields a given test
// needs — same pattern reminders.test.ts's eventStartingIn helper uses.
async function createEventAt(
  organizationId: string,
  anchor: Date,
  hoursFromAnchor: number,
  overrides: Partial<{ title: string; city: string; eventType: string; status: string }> = {},
  ticketTypes?: Array<{ priceCents: number; quantityTotal: number; quantitySold?: number }>
) {
  const event = await createTestEvent(organizationId, ticketTypes);
  return prisma.event.update({
    where: { id: event.id },
    data: {
      startsAt: new Date(anchor.getTime() + hoursFromAnchor * 60 * 60 * 1000),
      ...overrides,
    },
    include: { ticketTypes: true },
  });
}

describe("computeEventPricing", () => {
  it("reports the lowest price across ticket types", () => {
    const { lowestPriceCents } = computeEventPricing([
      { priceCents: 5000, quantityTotal: 10, quantitySold: 0 },
      { priceCents: 2000, quantityTotal: 10, quantitySold: 0 },
    ]);
    expect(lowestPriceCents).toBe(2000);
  });

  it("returns null lowest price when there are no ticket types", () => {
    expect(computeEventPricing([]).lowestPriceCents).toBeNull();
  });

  it("is sold out only when every ticket type is fully sold", () => {
    expect(
      computeEventPricing([{ priceCents: 1000, quantityTotal: 5, quantitySold: 5 }]).soldOut
    ).toBe(true);
    expect(
      computeEventPricing([
        { priceCents: 1000, quantityTotal: 5, quantitySold: 5 },
        { priceCents: 2000, quantityTotal: 5, quantitySold: 2 },
      ]).soldOut
    ).toBe(false);
    expect(computeEventPricing([]).soldOut).toBe(false);
  });

  it("is free only when every ticket type is priced at zero", () => {
    expect(computeEventPricing([{ priceCents: 0, quantityTotal: 5, quantitySold: 0 }]).isFree).toBe(true);
    expect(
      computeEventPricing([
        { priceCents: 0, quantityTotal: 5, quantitySold: 0 },
        { priceCents: 500, quantityTotal: 5, quantitySold: 0 },
      ]).isFree
    ).toBe(false);
  });
});

describe("getPublicEvents", () => {
  it("returns only LIVE, upcoming events, soonest first — excluding cancelled and past events", async () => {
    const { organizationId } = await newOrganizer();
    const anchor = nextAnchor();
    const soon = await createEventAt(organizationId, anchor, 24, { title: "Soon Event" });
    const later = await createEventAt(organizationId, anchor, 48, { title: "Later Event" });
    const past = await createEventAt(organizationId, anchor, -24, { title: "Past Event" });
    const cancelled = await createEventAt(organizationId, anchor, 30, {
      title: "Cancelled Event",
      status: "CANCELLED",
    });

    const result = await getPublicEvents({}, anchor);
    const ids = result.events.map((e) => e.id);

    expect(ids).toContain(soon.id);
    expect(ids).toContain(later.id);
    expect(ids).not.toContain(past.id);
    expect(ids).not.toContain(cancelled.id);
    expect(ids.indexOf(soon.id)).toBeLessThan(ids.indexOf(later.id));
  });

  it("filters by search across event title and organiser name", async () => {
    const { organizationId } = await newOrganizer();
    const anchor = nextAnchor();
    const match = await createEventAt(organizationId, anchor, 24, { title: "Zanzibar Beach Marathon" });
    const other = await createEventAt(organizationId, anchor, 24, { title: "City Football Derby" });

    const result = await getPublicEvents({ search: "zanzibar" }, anchor);
    const ids = result.events.map((e) => e.id);

    expect(ids).toContain(match.id);
    expect(ids).not.toContain(other.id);
  });

  it("filters by event type and by city", async () => {
    const { organizationId } = await newOrganizer();
    const anchor = nextAnchor();
    const marathon = await createEventAt(organizationId, anchor, 24, {
      title: "Type Filter Marathon",
      eventType: "MARATHON",
      city: "Arusha",
    });
    const conference = await createEventAt(organizationId, anchor, 24, {
      title: "Type Filter Conference",
      eventType: "CONFERENCE",
      city: "Dodoma",
    });

    const byType = await getPublicEvents({ eventType: "MARATHON" }, anchor);
    const byTypeIds = byType.events.map((e) => e.id);
    expect(byTypeIds).toContain(marathon.id);
    expect(byTypeIds).not.toContain(conference.id);

    const byCity = await getPublicEvents({ city: "arusha" }, anchor);
    const byCityIds = byCity.events.map((e) => e.id);
    expect(byCityIds).toContain(marathon.id);
    expect(byCityIds).not.toContain(conference.id);
  });

  // Creating EVENTS_PAGE_SIZE + 2 events (2 sequential Prisma round-trips
  // each, same createEventAt pattern as every other test here) plus two
  // full getPublicEvents queries measured well within the suite's normal
  // per-test budget in isolation, but ran this file's own tests hours into
  // an already-long full-suite run once — pass an explicit longer timeout
  // as a margin against that shared, ever-growing test database's variable
  // latency, same reasoning as vitest.config's global retry: 1.
  it(
    "paginates at EVENTS_PAGE_SIZE per page",
    async () => {
      const { organizationId } = await newOrganizer();
      const anchor = nextAnchor();
      const created = [];
      for (let i = 0; i < EVENTS_PAGE_SIZE + 2; i++) {
        created.push(await createEventAt(organizationId, anchor, 24 + i, { title: `Paginated Event ${i}` }));
      }

      const page1 = await getPublicEvents({ page: 1 }, anchor);
      const page2 = await getPublicEvents({ page: 2 }, anchor);

      expect(page1.total).toBe(created.length);
      expect(page1.pageCount).toBe(2);
      expect(page1.events).toHaveLength(EVENTS_PAGE_SIZE);
      expect(page2.events).toHaveLength(created.length - EVENTS_PAGE_SIZE);
    },
    120000
  );
});

describe("getFeaturedEvents", () => {
  it("ranks upcoming events by total tickets sold, descending", async () => {
    const { organizationId } = await newOrganizer();
    const anchor = nextAnchor();
    const low = await createEventAt(
      organizationId,
      anchor,
      24,
      { title: "Low Sales Featured Event" },
      [{ priceCents: 1000, quantityTotal: 100, quantitySold: 2 }]
    );
    const high = await createEventAt(
      organizationId,
      anchor,
      24,
      { title: "High Sales Featured Event" },
      [{ priceCents: 1000, quantityTotal: 100, quantitySold: 50 }]
    );

    const featured = await getFeaturedEvents(2, anchor);
    const ids = featured.map((e) => e.id);

    expect(ids).toContain(high.id);
    expect(ids).toContain(low.id);
    expect(ids.indexOf(high.id)).toBeLessThan(ids.indexOf(low.id));
  });
});

describe("getPublicEventCities", () => {
  it("returns distinct cities among upcoming events", async () => {
    const { organizationId } = await newOrganizer();
    const anchor = nextAnchor();
    await createEventAt(organizationId, anchor, 24, { title: "City List Event", city: "Mwanza" });

    const cities = await getPublicEventCities(anchor);
    expect(cities).toContain("Mwanza");
  });
});

describe("getPublishedEventSlugs", () => {
  it("includes LIVE events and excludes cancelled ones", async () => {
    const { organizationId } = await newOrganizer();
    const anchor = nextAnchor();
    const live = await createEventAt(organizationId, anchor, 24, { title: "Sitemap Live Event" });
    const cancelled = await createEventAt(organizationId, anchor, 24, {
      title: "Sitemap Cancelled Event",
      status: "CANCELLED",
    });

    const slugs = await getPublishedEventSlugs();
    const slugSet = slugs.map((s) => s.slug);

    expect(slugSet).toContain(live.slug);
    expect(slugSet).not.toContain(cancelled.slug);
  });
});

describe("getPlatformStats", () => {
  it("counts hosted events, tickets sold, and completed SALE volume — as deltas, since the shared test database is never reset", async () => {
    const before = await getPlatformStats();

    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId, [
      { priceCents: 100000, quantityTotal: 10, quantitySold: 3 },
    ]);
    const buyer = await createTestUser();
    const wallet = await createTestWallet(event.id, buyer.id);

    await prisma.walletTransaction.create({
      data: { walletId: wallet.id, type: "SALE", status: "COMPLETED", amountCents: 250000 },
    });
    // Should NOT count: not COMPLETED, and not a SALE.
    await prisma.walletTransaction.create({
      data: { walletId: wallet.id, type: "SALE", status: "PENDING", amountCents: 999999 },
    });
    await prisma.walletTransaction.create({
      data: { walletId: wallet.id, type: "TOPUP", status: "COMPLETED", amountCents: 999999 },
    });

    const after = await getPlatformStats();

    expect(after.totalEventsHosted - before.totalEventsHosted).toBe(1);
    expect(after.totalTicketsSold - before.totalTicketsSold).toBe(3);
    expect(after.totalCashlessVolumeCents - before.totalCashlessVolumeCents).toBe(250000);
    expect(after.currency).toBe("TZS");
  });
});
