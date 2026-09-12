import { describe, expect, it, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestUser, createTestOrganization, addMembership, createTestEvent } from "@/lib/test-fixtures";
import { handleSellTickets, handleRecordChipTime } from "@/lib/sync-handlers";
import {
  computeGunTimeOffsetSeconds,
  computeSplitTimeSeconds,
  formatElapsed,
  computePaceSecondsPerKm,
  formatPace,
} from "@/lib/timing";
import { buildLeaderboard, countDNFs, type AthleteProgress } from "@/lib/leaderboard";
import { getTimingDashboardData, buildTimingResultsCsvSections } from "@/lib/timing-data";

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

// Neon connection-pool drain — setupMarathon alone chains ~8 sequential
// Prisma calls, and several tests here layer multiple handleRecordChipTime
// transactions on top of it. Under vitest's parallel workers this file has
// been observed contributing to pool exhaustion that surfaces as timeouts
// elsewhere in the suite. A short pause between tests gives Neon's pooler
// room to release connections before the next test's setup starts.
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
});

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { user, organizationId: organization.id };
}

// A marathon event with one Start / one 10km / one Finish timing point,
// and one athlete with a provisioned (ticket-linked) NFC credential.
async function setupMarathon(overrides: { gunStartAt?: Date | null } = {}) {
  const { user: owner, organizationId } = await newOrganizer();
  const event = await createTestEvent(organizationId, [{ priceCents: 500_000, quantityTotal: 200 }]);
  await prisma.event.update({
    where: { id: event.id },
    data: { eventType: "MARATHON", gunStartAt: overrides.gunStartAt === undefined ? new Date() : overrides.gunStartAt },
  });

  const athlete = await createTestUser({ name: "Amina Runner" });
  await handleSellTickets(athlete.id, {
    clientId: uid("order"),
    eventId: event.id,
    items: [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1, codes: [uid("BIB")] }],
  });
  const ticket = await prisma.ticket.findFirstOrThrow({ where: { eventId: event.id, order: { userId: athlete.id } } });

  const nfcUid = uid("nfc").toUpperCase();
  const credential = await prisma.credential.create({
    data: {
      organizationId,
      ticketId: ticket.id,
      code: ticket.code,
      nfcUid,
      status: "ACTIVE",
      createdByUserId: owner.id,
      createdByName: owner.name,
    },
  });

  const start = await prisma.timingPoint.create({
    data: { eventId: event.id, clientId: uid("tp"), name: "Start", sequenceOrder: 0, isStart: true, isFinish: false },
  });
  const tenK = await prisma.timingPoint.create({
    data: { eventId: event.id, clientId: uid("tp"), name: "10km", sequenceOrder: 10, isStart: false, isFinish: false, distanceMeters: 10_000 },
  });
  const finish = await prisma.timingPoint.create({
    data: { eventId: event.id, clientId: uid("tp"), name: "Finish", sequenceOrder: 20, isStart: false, isFinish: true, distanceMeters: 21_097 },
  });

  return { owner, organizationId, event, athlete, ticket, credential, start, tenK, finish };
}

function tapPayload(overrides: Record<string, unknown>) {
  return { clientId: uid("chip"), recordedAt: new Date().toISOString(), ...overrides };
}

describe("computeGunTimeOffsetSeconds / computeSplitTimeSeconds", () => {
  it("computes gun time as whole seconds since gunStartAt", () => {
    const gunStartAt = new Date("2026-01-01T06:00:00Z");
    const recordedAt = new Date("2026-01-01T07:01:01Z"); // +3661s
    expect(computeGunTimeOffsetSeconds(gunStartAt, recordedAt)).toBe(3661);
  });

  it("floors a tap before the gun to zero rather than going negative", () => {
    const gunStartAt = new Date("2026-01-01T06:00:00Z");
    const recordedAt = new Date("2026-01-01T05:59:00Z");
    expect(computeGunTimeOffsetSeconds(gunStartAt, recordedAt)).toBe(0);
  });

  it("is null when the race hasn't started", () => {
    expect(computeGunTimeOffsetSeconds(null, new Date())).toBeNull();
  });

  it("computes split time from the previous point's recordedAt", () => {
    const prev = new Date("2026-01-01T06:30:00Z");
    const now = new Date("2026-01-01T07:00:00Z");
    expect(computeSplitTimeSeconds(now, prev)).toBe(1800);
  });

  it("is null at the first timing point (no previous tap)", () => {
    expect(computeSplitTimeSeconds(new Date(), null)).toBeNull();
  });
});

describe("formatElapsed / computePaceSecondsPerKm / formatPace", () => {
  it("formats elapsed seconds as HH:MM:SS", () => {
    expect(formatElapsed(3661)).toBe("01:01:01");
    expect(formatElapsed(59)).toBe("00:00:59");
  });

  it("computes pace per km from elapsed time and distance", () => {
    // 21,097.5m half marathon in exactly 1:30:00 → ~4:16/km
    const pace = computePaceSecondsPerKm(5400, 21_097);
    expect(pace).not.toBeNull();
    expect(formatPace(pace)).toMatch(/^\d:\d\d \/km$/);
  });

  it("is null when the distance isn't known", () => {
    expect(computePaceSecondsPerKm(3600, null)).toBeNull();
    expect(formatPace(null)).toBe("—");
  });
});

describe("handleRecordChipTime", () => {
  // Neon cold-start/latency headroom — setupMarathon alone chains ~8
  // sequential Prisma calls (org, event, ticket sale, credential, three
  // timing points), which has been observed pushing this test past the
  // default 60s under sustained load; 120s gives it room without masking a
  // genuine hang (see vitest.global-setup.ts's warm-up-query comment for
  // why Neon's compute can add several seconds of cold-start latency per
  // query). recordedAt is a FIXED offset from gunStartAt, not `new Date()`
  // — real wall-clock time elapsed during setupMarathon's own Neon round
  // trips would otherwise make the gun-time assertion flaky, same reasoning
  // the split-time test below already uses fixed offsets throughout.
  it(
    "records a chip time via NFC uid, computing gun time and leaving split null at the first point",
    { timeout: 120000 },
    async () => {
      const gunStartAt = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
      const { organizationId, event, start, credential } = await setupMarathon({ gunStartAt });

      const recordedAt = new Date(gunStartAt.getTime() + 600_000); // exactly +600s
      const result: any = await handleRecordChipTime(
        organizationId,
        tapPayload({ eventId: event.id, timingPointId: start.id, nfcUid: credential.nfcUid, recordedAt: recordedAt.toISOString() })
      );

      expect(result.ok).toBe(true);
      expect(result.chipTime.credentialId).toBe(credential.id);
      expect(result.chipTime.athleteName).toBe("Amina Runner");
      expect(result.chipTime.bib).toBe(credential.nfcUid!.slice(-4).toUpperCase());
      expect(result.chipTime.splitTimeSeconds).toBeNull();
      expect(result.chipTime.gunTimeOffsetSeconds).toBe(600);
    }
  );

  it("also resolves via a QR/manual ticket code scan, landing on the same credential", async () => {
    const { organizationId, event, start, credential, ticket } = await setupMarathon();
    const result: any = await handleRecordChipTime(
      organizationId,
      tapPayload({ eventId: event.id, timingPointId: start.id, ticketCode: ticket.code })
    );
    expect(result.ok).toBe(true);
    expect(result.chipTime.credentialId).toBe(credential.id);
  });

  // Neon latency headroom, same reasoning as the test above — setupMarathon
  // plus three sequential handleRecordChipTime calls each doing their own
  // multi-query lookups.
  it(
    "calculates split time from the previous timing point's recorded tap, by course order not creation order",
    { timeout: 120000 },
    async () => {
      const gunStartAt = new Date(Date.now() - 3600 * 1000);
      const { organizationId, event, start, tenK, finish, credential } = await setupMarathon({ gunStartAt });

      const startAt = new Date(gunStartAt.getTime());
      await handleRecordChipTime(organizationId, tapPayload({ eventId: event.id, timingPointId: start.id, nfcUid: credential.nfcUid, recordedAt: startAt.toISOString() }));

      const tenKAt = new Date(startAt.getTime() + 1800_000); // +30 min
      const tenKResult: any = await handleRecordChipTime(organizationId, tapPayload({ eventId: event.id, timingPointId: tenK.id, nfcUid: credential.nfcUid, recordedAt: tenKAt.toISOString() }));
      expect(tenKResult.chipTime.splitTimeSeconds).toBe(1800);
      expect(tenKResult.chipTime.gunTimeOffsetSeconds).toBe(1800);

      const finishAt = new Date(tenKAt.getTime() + 2700_000); // +45 min more
      const finishResult: any = await handleRecordChipTime(organizationId, tapPayload({ eventId: event.id, timingPointId: finish.id, nfcUid: credential.nfcUid, recordedAt: finishAt.toISOString() }));
      expect(finishResult.chipTime.splitTimeSeconds).toBe(2700);
      expect(finishResult.chipTime.gunTimeOffsetSeconds).toBe(1800 + 2700);
    }
  );

  // Neon latency headroom, same reasoning as the tests above — setupMarathon
  // plus two sequential handleRecordChipTime transactions.
  it("is idempotent — replaying the same clientId returns the same row rather than duplicating", { timeout: 120000 }, async () => {
    const { organizationId, event, start, credential } = await setupMarathon();
    const payload = tapPayload({ eventId: event.id, timingPointId: start.id, nfcUid: credential.nfcUid });

    const first: any = await handleRecordChipTime(organizationId, payload);
    const second: any = await handleRecordChipTime(organizationId, payload);
    expect(second.chipTime.id).toBe(first.chipTime.id);

    const count = await prisma.chipTime.count({ where: { credentialId: credential.id, timingPointId: start.id } });
    expect(count).toBe(1);
  });

  // Neon latency headroom, same reasoning as the tests above.
  it("returns the existing row on a re-scan of the same athlete at the same point (no duplicate)", { timeout: 120000 }, async () => {
    const { organizationId, event, start, credential } = await setupMarathon();
    const first: any = await handleRecordChipTime(organizationId, tapPayload({ eventId: event.id, timingPointId: start.id, nfcUid: credential.nfcUid }));
    // A different clientId (a fresh scan, not a network retry) at the same point
    const second: any = await handleRecordChipTime(organizationId, tapPayload({ eventId: event.id, timingPointId: start.id, nfcUid: credential.nfcUid }));
    expect(second.chipTime.id).toBe(first.chipTime.id);
    const count = await prisma.chipTime.count({ where: { credentialId: credential.id, timingPointId: start.id } });
    expect(count).toBe(1);
  });

  it("rejects a tap with no matching provisioned credential", async () => {
    const { organizationId, event, start } = await setupMarathon();
    const result: any = await handleRecordChipTime(organizationId, tapPayload({ eventId: event.id, timingPointId: start.id, nfcUid: "NEVER-PROVISIONED" }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("CREDENTIAL_NOT_FOUND");
  });
});

describe("buildLeaderboard", () => {
  const athlete = (id: string, name: string, finishSeconds: number | null, distanceMeters = 21_097): AthleteProgress => ({
    credentialId: id,
    athleteName: name,
    bib: id.slice(-4),
    ticketTypeId: "half",
    ticketTypeName: "Half Marathon",
    times:
      finishSeconds == null
        ? [{ timingPointId: "start", sequenceOrder: 0, isStart: true, isFinish: false, distanceMeters: null, gunTimeOffsetSeconds: 60 }]
        : [
            { timingPointId: "start", sequenceOrder: 0, isStart: true, isFinish: false, distanceMeters: null, gunTimeOffsetSeconds: 0 },
            { timingPointId: "finish", sequenceOrder: 20, isStart: false, isFinish: true, distanceMeters, gunTimeOffsetSeconds: finishSeconds },
          ],
  });

  it("ranks finishers fastest-first, separately from athletes still on course", () => {
    const result = buildLeaderboard([
      athlete("cred-slow", "Slow Sam", 7200),
      athlete("cred-fast", "Fast Faraja", 5400),
      athlete("cred-oncourse", "On Course Omari", null),
    ]);
    expect(result.finishers.map((r) => r.athleteName)).toEqual(["Fast Faraja", "Slow Sam"]);
    expect(result.finishers[0].rank).toBe(1);
    expect(result.finishers[1].rank).toBe(2);
    expect(result.inProgress.map((r) => r.athleteName)).toEqual(["On Course Omari"]);
  });

  it("filters to one ticket type when requested", () => {
    const full = { ...athlete("cred-full", "Full Runner", 14400), ticketTypeId: "full", ticketTypeName: "Full Marathon" };
    const half = athlete("cred-half", "Half Runner", 5400);
    const result = buildLeaderboard([full, half], "half");
    expect(result.finishers.map((r) => r.athleteName)).toEqual(["Half Runner"]);
  });
});

describe("countDNFs", () => {
  const started = (id: string): AthleteProgress => ({
    credentialId: id,
    athleteName: id,
    bib: id,
    ticketTypeId: "t",
    ticketTypeName: "t",
    times: [{ timingPointId: "start", sequenceOrder: 0, isStart: true, isFinish: false, distanceMeters: null, gunTimeOffsetSeconds: 0 }],
  });
  const finished = (id: string): AthleteProgress => ({
    ...started(id),
    times: [
      ...started(id).times,
      { timingPointId: "finish", sequenceOrder: 20, isStart: false, isFinish: true, distanceMeters: null, gunTimeOffsetSeconds: 3600 },
    ],
  });

  it("counts started-but-not-finished athletes only once the race has ended", () => {
    const athletes = [started("a"), started("b"), finished("c")];
    expect(countDNFs(athletes, false)).toBe(0); // race still running — no DNFs yet
    expect(countDNFs(athletes, true)).toBe(2);
  });
});

describe("getTimingDashboardData", () => {
  // Neon latency headroom, same reasoning as the handleRecordChipTime tests
  // above — this one does setupMarathon plus a second full athlete setup
  // plus four handleRecordChipTime calls, the heaviest test in this file.
  it("reports starters, finishers, DNF and per-point counts from real ChipTime rows", { timeout: 120000 }, async () => {
    const gunStartAt = new Date(Date.now() - 2 * 3600 * 1000);
    const { organizationId, event, start, tenK, finish, credential } = await setupMarathon({ gunStartAt });

    // Finisher: taps at all three points
    await handleRecordChipTime(organizationId, tapPayload({ eventId: event.id, timingPointId: start.id, nfcUid: credential.nfcUid, recordedAt: gunStartAt.toISOString() }));
    await handleRecordChipTime(organizationId, tapPayload({ eventId: event.id, timingPointId: tenK.id, nfcUid: credential.nfcUid, recordedAt: new Date(gunStartAt.getTime() + 1800_000).toISOString() }));
    await handleRecordChipTime(organizationId, tapPayload({ eventId: event.id, timingPointId: finish.id, nfcUid: credential.nfcUid, recordedAt: new Date(gunStartAt.getTime() + 5400_000).toISOString() }));

    // A DNF: a second athlete who started but never finished
    const dnfAthlete = await createTestUser({ name: "DNF Dennis" });
    await handleSellTickets(dnfAthlete.id, {
      clientId: uid("order"),
      eventId: event.id,
      items: [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1, codes: [uid("BIB")] }],
    });
    const dnfTicket = await prisma.ticket.findFirstOrThrow({ where: { eventId: event.id, order: { userId: dnfAthlete.id } } });
    const dnfCredential = await prisma.credential.create({
      data: { organizationId, ticketId: dnfTicket.id, code: dnfTicket.code, nfcUid: uid("nfc2").toUpperCase(), status: "ACTIVE", createdByUserId: dnfAthlete.id, createdByName: dnfAthlete.name },
    });
    await handleRecordChipTime(organizationId, tapPayload({ eventId: event.id, timingPointId: start.id, nfcUid: dnfCredential.nfcUid, recordedAt: gunStartAt.toISOString() }));

    // Race ended in the past — DNF should count
    await prisma.event.update({ where: { id: event.id }, data: { endsAt: new Date(Date.now() - 3600 * 1000) } });

    const data = await getTimingDashboardData(event.id);
    expect(data!.totalStarters).toBe(2);
    expect(data!.totalFinishers).toBe(1);
    expect(data!.dnfCount).toBe(1);
    expect(data!.raceEnded).toBe(true);
    expect(data!.perPointCounts.find((p) => p.name === "10km")!.count).toBe(1);
    expect(data!.leaders.finishers).toHaveLength(1);
    expect(data!.leaders.finishers[0].athleteName).toBe("Amina Runner");
  });
});

describe("buildTimingResultsCsvSections", () => {
  it("returns a summary, per-point, and finish-results section with the right headers", async () => {
    const { event } = await setupMarathon();
    const data = await getTimingDashboardData(event.id);
    const sections = buildTimingResultsCsvSections(data!);

    expect(sections.map((s) => s.title)).toEqual([
      `Timing summary — ${event.title}`,
      "Per-timing-point counts",
      "Finish results",
    ]);
    expect(sections[0].headers).toEqual(["Metric", "Value"]);
    expect(sections[1].headers).toEqual(["Timing point", "Athletes recorded"]);
    expect(sections[2].headers).toEqual(["Rank", "Athlete", "Bib", "Ticket type", "Gun time", "Pace"]);
  });
});
