import { describe, expect, it, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestUser, createTestOrganization, addMembership, createTestEvent } from "@/lib/test-fixtures";
import { handleSellTickets } from "@/lib/sync-handlers";
import { rankResults, formatFinishTime, calculatePace, type RawMarathonFinisher } from "@/lib/marathon-results";
import { getMarathonResults, getDNFs, getMarathonRaceCounts } from "@/lib/marathon-results-data";

// Session — official marathon results PDF. DB-backed describes run against
// the real test database, same convention as timing.test.ts/
// post-event-memory.test.ts.

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
});

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { user, organizationId: organization.id };
}

// A MARATHON event with Start/Finish timing points and two ticket types
// (Full Marathon / Half Marathon), for tests that need real ChipTime rows.
async function setupMarathon() {
  const { user: owner, organizationId } = await newOrganizer();
  const event = await createTestEvent(organizationId, [
    { priceCents: 500_000, quantityTotal: 100, name: "Full Marathon" },
    { priceCents: 300_000, quantityTotal: 100, name: "Half Marathon" },
  ]);
  await prisma.event.update({ where: { id: event.id }, data: { eventType: "MARATHON", gunStartAt: new Date(Date.now() - 5 * 3600_000) } });

  const start = await prisma.timingPoint.create({
    data: { eventId: event.id, clientId: uid("tp"), name: "Start", sequenceOrder: 0, isStart: true, isFinish: false },
  });
  const finish = await prisma.timingPoint.create({
    data: { eventId: event.id, clientId: uid("tp"), name: "Finish", sequenceOrder: 20, isStart: false, isFinish: true, distanceMeters: 42_195 },
  });

  return { owner, organizationId, event, start, finish };
}

async function athlete(eventId: string, ticketTypeId: string, name: string) {
  const buyer = await createTestUser({ name });
  const sale = await handleSellTickets(buyer.id, {
    clientId: uid("order"),
    eventId,
    items: [{ ticketTypeId, quantity: 1, codes: [uid("code")] }],
  });
  const ticket = sale.order!.tickets[0];
  const credential = await prisma.credential.create({
    data: {
      organizationId: (await prisma.event.findUniqueOrThrow({ where: { id: eventId } })).organizationId,
      ticketId: ticket.id,
      code: ticket.code,
      status: "ACTIVE",
      createdByUserId: buyer.id,
      createdByName: buyer.name,
    },
  });
  return { buyer, ticket, credential };
}

async function tap(eventId: string, timingPointId: string, credentialId: string, gunTimeOffsetSeconds: number) {
  return prisma.chipTime.create({
    data: { eventId, timingPointId, credentialId, recordedAt: new Date(), gunTimeOffsetSeconds },
  });
}

describe("formatFinishTime", () => {
  it("formats sub-hour times as M:SS", () => {
    expect(formatFinishTime(374)).toBe("6:14");
  });

  it("formats hour-plus times as H:MM:SS", () => {
    expect(formatFinishTime(15734)).toBe("4:22:14");
  });
});

describe("calculatePace", () => {
  it("returns pace per km", () => {
    // Half marathon (21097m) in 1:30:00 → ~4:16/km
    expect(calculatePace(5400, 21_097)).toMatch(/^\d:\d\d \/km$/);
  });

  it("returns an em dash when distance is unknown", () => {
    expect(calculatePace(3600, null)).toBe("—");
  });
});

describe("rankResults", () => {
  const finisher = (over: Partial<RawMarathonFinisher>): RawMarathonFinisher => ({
    credentialId: uid("cred"),
    athleteName: "Athlete",
    bib: "0001",
    ticketTypeName: "Full Marathon",
    gunTimeOffsetSeconds: 10800,
    chipTimeOffsetSeconds: null,
    distanceMeters: 42_195,
    ...over,
  });

  it("ranks overall by gun time ascending, fastest first", () => {
    const ranked = rankResults([
      finisher({ athleteName: "Slow Sam", gunTimeOffsetSeconds: 14400 }),
      finisher({ athleteName: "Fast Faraja", gunTimeOffsetSeconds: 10800 }),
    ]);
    expect(ranked.map((r) => r.athleteName)).toEqual(["Fast Faraja", "Slow Sam"]);
    expect(ranked[0].overallRank).toBe(1);
    expect(ranked[1].overallRank).toBe(2);
  });

  it("assigns category ranks independently per ticket type", () => {
    const ranked = rankResults([
      finisher({ athleteName: "Full Winner", ticketTypeName: "Full Marathon", gunTimeOffsetSeconds: 10800 }),
      finisher({ athleteName: "Half Winner", ticketTypeName: "Half Marathon", gunTimeOffsetSeconds: 12000 }),
      finisher({ athleteName: "Full Runner-up", ticketTypeName: "Full Marathon", gunTimeOffsetSeconds: 12600 }),
    ]);
    const halfWinner = ranked.find((r) => r.athleteName === "Half Winner")!;
    const fullRunnerUp = ranked.find((r) => r.athleteName === "Full Runner-up")!;
    expect(halfWinner.categoryRank).toBe(1);
    expect(fullRunnerUp.overallRank).toBe(3);
    expect(fullRunnerUp.categoryRank).toBe(2);
  });

  it("assigns medals 1/2/3 to the top 3 in each category and null beyond that", () => {
    const ranked = rankResults([
      finisher({ athleteName: "A", gunTimeOffsetSeconds: 10000 }),
      finisher({ athleteName: "B", gunTimeOffsetSeconds: 11000 }),
      finisher({ athleteName: "C", gunTimeOffsetSeconds: 12000 }),
      finisher({ athleteName: "D", gunTimeOffsetSeconds: 13000 }),
    ]);
    expect(ranked.map((r) => r.medal)).toEqual([1, 2, 3, null]);
  });

  it("omits chipTimeFormatted when net time equals gun time", () => {
    const ranked = rankResults([finisher({ chipTimeOffsetSeconds: null })]);
    expect(ranked[0].chipTimeFormatted).toBeNull();
  });

  it("includes chipTimeFormatted when net time differs from gun time", () => {
    const ranked = rankResults([finisher({ gunTimeOffsetSeconds: 10800, chipTimeOffsetSeconds: 10500 })]);
    expect(ranked[0].chipTimeFormatted).toBe(formatFinishTime(10500));
  });

  it("returns an empty array gracefully for no results", () => {
    expect(rankResults([])).toEqual([]);
  });
});

describe("getMarathonResults / getDNFs / getMarathonRaceCounts", () => {
  it(
    "ranks real finishers by gun time and assigns per-category ranks",
    { timeout: 120000 },
    async () => {
      const { event, start, finish } = await setupMarathon();
      const full = event.ticketTypes.find((t) => t.name === "Full Marathon")!.id;
      const half = event.ticketTypes.find((t) => t.name === "Half Marathon")!.id;

      const a = await athlete(event.id, full, "Fast Full Faraja");
      await tap(event.id, start.id, a.credential.id, 0);
      await tap(event.id, finish.id, a.credential.id, 10800);

      const b = await athlete(event.id, half, "Half Runner");
      await tap(event.id, start.id, b.credential.id, 0);
      await tap(event.id, finish.id, b.credential.id, 5400);

      const results = await getMarathonResults(event.id);
      expect(results.map((r) => r.athleteName)).toEqual(["Half Runner", "Fast Full Faraja"]);
      expect(results[0].overallRank).toBe(1);
      expect(results[0].categoryRank).toBe(1);
      expect(results[1].categoryRank).toBe(1);
    }
  );

  it(
    "detects a DNF as started-but-not-finished, distinct from finishers",
    { timeout: 120000 },
    async () => {
      const { event, start, finish } = await setupMarathon();
      const full = event.ticketTypes.find((t) => t.name === "Full Marathon")!.id;

      const finisher = await athlete(event.id, full, "Finisher Fatima");
      await tap(event.id, start.id, finisher.credential.id, 0);
      await tap(event.id, finish.id, finisher.credential.id, 10800);

      const dnf = await athlete(event.id, full, "DNF Dennis");
      await tap(event.id, start.id, dnf.credential.id, 0);

      const results = await getMarathonResults(event.id);
      expect(results.map((r) => r.athleteName)).toEqual(["Finisher Fatima"]);

      const dnfs = await getDNFs(event.id);
      expect(dnfs).toHaveLength(1);
      expect(dnfs[0].athleteName).toBe("DNF Dennis");

      const counts = await getMarathonRaceCounts(event.id);
      expect(counts.totalStarters).toBe(2);
      expect(counts.totalFinishers).toBe(1);
      expect(counts.dnfCount).toBe(1);
    }
  );

  it("returns empty results/DNFs gracefully for an event with no chip times", async () => {
    const { event } = await setupMarathon();
    expect(await getMarathonResults(event.id)).toEqual([]);
    expect(await getDNFs(event.id)).toEqual([]);
    const counts = await getMarathonRaceCounts(event.id);
    expect(counts).toEqual({ totalStarters: 0, totalFinishers: 0, dnfCount: 0 });
  });
});
