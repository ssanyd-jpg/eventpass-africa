import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createTestUser,
  createTestOrganization,
  addMembership,
  createTestEvent,
  createTestWallet,
} from "@/lib/test-fixtures";
import { handleSellTickets } from "@/lib/sync-handlers";
import {
  computeScenario,
  computeForecast,
  projectedDailyRevenue,
  summarizeHistoricalPerformance,
  NET_BREAKAGE_RATE,
  PLATFORM_REVENUE_RATE,
  type ForecastInputs,
  type TicketTier,
} from "@/lib/revenue-forecast";
import { getForecastPageData, saveEventForecastCore, canAccessForecast } from "@/lib/revenue-forecast-data";

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { user, organizationId: organization.id };
}

const INPUTS: ForecastInputs = {
  expectedAttendance: 1000,
  cashlessAdoptionRate: 0.6,
  avgSpendCents: 1_500_000, // TZS 15,000
  durationDays: 1,
};
const ONE_TIER: TicketTier[] = [{ priceCents: 2_000_000, quantityTotal: 1000 }]; // TZS 20,000

describe("computeScenario", () => {
  it("Base uses 100% attendance and the inputted adoption + spend", () => {
    const s = computeScenario(INPUTS, ONE_TIER, "base");
    expect(s.projectedAttendance).toBe(1000);
    expect(s.cashlessAttendees).toBe(600); // 1000 * 0.6
    expect(s.ticketRevenueCents).toBe(2_000_000_000); // 2,000,000 * 1000
    expect(s.topUpVolumeCents).toBe(900_000_000); // 600 * 1,500,000
    expect(s.netBreakageCents).toBe(45_000_000); // 5%
    expect(s.cashlessSpendCents).toBe(855_000_000); // topUp - breakage
    expect(s.platformRevenueCents).toBe(18_000_000); // 2%
    expect(s.totalRevenueCents).toBe(2_900_000_000); // ticket + topUp
  });

  it("Low uses 70% attendance, a fixed 40% adoption and 80% spend", () => {
    const s = computeScenario(INPUTS, ONE_TIER, "low");
    expect(s.projectedAttendance).toBe(700);
    expect(s.cashlessAttendees).toBe(280); // 700 * 0.4
    expect(s.ticketRevenueCents).toBe(1_400_000_000);
    expect(s.topUpVolumeCents).toBe(336_000_000); // 280 * (1,500,000 * 0.8)
    expect(s.netBreakageCents).toBe(16_800_000);
    expect(s.totalRevenueCents).toBe(1_736_000_000);
  });

  it("High uses 120% attendance, a fixed 80% adoption and 120% spend", () => {
    const s = computeScenario(INPUTS, ONE_TIER, "high");
    expect(s.projectedAttendance).toBe(1200);
    expect(s.cashlessAttendees).toBe(960); // 1200 * 0.8
    expect(s.ticketRevenueCents).toBe(2_400_000_000);
    expect(s.topUpVolumeCents).toBe(1_728_000_000); // 960 * (1,500,000 * 1.2)
    expect(s.platformRevenueCents).toBe(34_560_000);
    expect(s.totalRevenueCents).toBe(4_128_000_000);
  });

  it("pro-rates projected attendance across tiers by capacity share", () => {
    const tiers: TicketTier[] = [
      { priceCents: 2_000_000, quantityTotal: 300 },
      { priceCents: 5_000_000, quantityTotal: 700 },
    ];
    // Base attendance 1000 → 300 in tier 1, 700 in tier 2
    const s = computeScenario({ ...INPUTS, expectedAttendance: 1000 }, tiers, "base");
    expect(s.ticketRevenueCents).toBe(2_000_000 * 300 + 5_000_000 * 700);
  });

  it("keeps the three cashless lines reconciled: topUp = spend + breakage", () => {
    for (const key of ["low", "base", "high"] as const) {
      const s = computeScenario(INPUTS, ONE_TIER, key);
      expect(s.cashlessSpendCents + s.netBreakageCents).toBe(s.topUpVolumeCents);
      expect(s.netBreakageCents).toBe(Math.round(s.topUpVolumeCents * NET_BREAKAGE_RATE));
      expect(s.platformRevenueCents).toBe(Math.round(s.topUpVolumeCents * PLATFORM_REVENUE_RATE));
    }
  });
});

describe("projectedDailyRevenue", () => {
  it("puts the whole total on one day for a single-day event", () => {
    const curve = projectedDailyRevenue(1_000_000, 1);
    expect(curve).toHaveLength(1);
    expect(curve[0].value).toBe(1_000_000);
  });

  it("spreads across the run for a multi-day event, summing to ~the total", () => {
    const curve = projectedDailyRevenue(3_000_000, 3);
    expect(curve).toHaveLength(3);
    const sum = curve.reduce((a, p) => a + p.value, 0);
    expect(Math.abs(sum - 3_000_000)).toBeLessThanOrEqual(3); // rounding only
  });
});

describe("computeForecast", () => {
  it("returns all three scenarios plus a daily curve of the right length", () => {
    const f = computeForecast({ ...INPUTS, durationDays: 4 }, ONE_TIER);
    expect(Object.keys(f.scenarios).sort()).toEqual(["base", "high", "low"]);
    expect(f.dailyCurve).toHaveLength(4);
  });
});

describe("summarizeHistoricalPerformance", () => {
  it("averages per-event adoption and spend-per-cashless-head, skipping events with no ticket holders", () => {
    const summary = summarizeHistoricalPerformance([
      { ticketHolders: 100, walletCount: 40, topUpVolumeCents: 40 * 10_000 }, // 0.4 adoption, 10,000/head
      { ticketHolders: 200, walletCount: 120, topUpVolumeCents: 120 * 20_000 }, // 0.6 adoption, 20,000/head
      { ticketHolders: 0, walletCount: 0, topUpVolumeCents: 0 }, // skipped
    ]);
    expect(summary.eventCount).toBe(3);
    expect(summary.avgCashlessAdoptionRate).toBeCloseTo(0.5); // (0.4 + 0.6) / 2
    expect(summary.avgSpendPerHeadCents).toBe(15_000); // (10,000 + 20,000) / 2
  });

  it("returns nulls when there is no usable history", () => {
    const summary = summarizeHistoricalPerformance([{ ticketHolders: 0, walletCount: 0, topUpVolumeCents: 0 }]);
    expect(summary.avgCashlessAdoptionRate).toBeNull();
    expect(summary.avgSpendPerHeadCents).toBeNull();
  });
});

describe("getForecastPageData", () => {
  // Neon cold-start/latency headroom — this test builds two full past
  // events (createTestEvent + handleSellTickets + several wallet/top-up
  // rows each) plus the target event before the assertion, and has been
  // observed timing out at the default 60s under sustained full-suite load;
  // 120s gives it room without masking a genuine hang (see
  // vitest.global-setup.ts's warm-up-query comment on why Neon's compute
  // can add several seconds of cold-start latency per query).
  it("computes historical figures from the organiser's past events", { timeout: 120000 }, async () => {
    const { user: buyer, organizationId } = await newOrganizer();

    // Past event 1: 2 tickets, 1 wallet, 20,000 topped up → adoption 0.5, 20,000/head
    const pe1 = await createTestEvent(organizationId, [{ priceCents: 100_000, quantityTotal: 10 }]);
    await prisma.event.update({ where: { id: pe1.id }, data: { startsAt: new Date(Date.now() - 30 * 86400000) } });
    await handleSellTickets(buyer.id, {
      clientId: uid("o"),
      eventId: pe1.id,
      items: [{ ticketTypeId: pe1.ticketTypes[0].id, quantity: 2, codes: [uid("c"), uid("c")] }],
    });
    const w1 = await createTestWallet(pe1.id, buyer.id, { balanceCents: 0 });
    await prisma.walletTransaction.create({
      data: { type: "TOPUP", status: "COMPLETED", amountCents: 20_000, currency: "TZS", walletId: w1.id },
    });

    // Past event 2: 4 tickets, 2 wallets, 60,000 total topped up → adoption 0.5, 30,000/head
    const pe2 = await createTestEvent(organizationId, [{ priceCents: 100_000, quantityTotal: 10 }]);
    await prisma.event.update({ where: { id: pe2.id }, data: { startsAt: new Date(Date.now() - 20 * 86400000) } });
    await handleSellTickets(buyer.id, {
      clientId: uid("o"),
      eventId: pe2.id,
      items: [{ ticketTypeId: pe2.ticketTypes[0].id, quantity: 4, codes: [uid("c"), uid("c"), uid("c"), uid("c")] }],
    });
    for (let i = 0; i < 2; i++) {
      const holder = await createTestUser();
      const w = await createTestWallet(pe2.id, holder.id, { balanceCents: 0 });
      await prisma.walletTransaction.create({
        data: { type: "TOPUP", status: "COMPLETED", amountCents: 30_000, currency: "TZS", walletId: w.id },
      });
    }

    // The event we're forecasting (future — excluded from history by id anyway)
    const target = await createTestEvent(organizationId, [{ priceCents: 200_000, quantityTotal: 500 }]);

    const data = await getForecastPageData(target.id);
    expect(data).not.toBeNull();
    expect(data!.defaultExpectedAttendance).toBe(500);
    expect(data!.historical.eventCount).toBe(2);
    expect(data!.historical.avgCashlessAdoptionRate).toBeCloseTo(0.5);
    expect(data!.historical.avgSpendPerHeadCents).toBe(25_000); // (20,000 + 30,000) / 2
  });

  it("restores a saved forecast on the next load, and re-saving updates the same row", async () => {
    const { user: organiser, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId, [{ priceCents: 200_000, quantityTotal: 300 }]);

    expect((await getForecastPageData(event.id))!.savedForecast).toBeNull();

    await saveEventForecastCore({
      eventId: event.id,
      savedByUserId: organiser.id,
      expectedAttendance: 420,
      cashlessAdoptionRate: 0.65,
      avgSpendCents: 1_200_000,
      durationDays: 3,
    });

    const restored = (await getForecastPageData(event.id))!.savedForecast!;
    expect(restored.expectedAttendance).toBe(420);
    expect(restored.cashlessAdoptionRate).toBeCloseTo(0.65);
    expect(restored.avgSpendCents).toBe(1_200_000);
    expect(restored.durationDays).toBe(3);

    await saveEventForecastCore({
      eventId: event.id,
      savedByUserId: organiser.id,
      expectedAttendance: 999,
      cashlessAdoptionRate: 0.5,
      avgSpendCents: 2_000_000,
      durationDays: 1,
    });

    const rows = await prisma.eventForecast.findMany({ where: { eventId: event.id } });
    expect(rows).toHaveLength(1);
    expect((await getForecastPageData(event.id))!.savedForecast!.expectedAttendance).toBe(999);
  });
});

describe("canAccessForecast", () => {
  it("blocks GATE_CREW and allows OWNER / STAFF", () => {
    expect(canAccessForecast("GATE_CREW")).toBe(false);
    expect(canAccessForecast("OWNER")).toBe(true);
    expect(canAccessForecast("STAFF")).toBe(true);
    expect(canAccessForecast(undefined)).toBe(true);
  });
});
