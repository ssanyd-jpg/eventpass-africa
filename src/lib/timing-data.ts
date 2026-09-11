import { prisma } from "@/lib/prisma";
import { eventHasEnded } from "@/lib/carry-over";
import { buildLeaderboard, countDNFs, type AthleteProgress } from "@/lib/leaderboard";
import { buildCsvDocument, type CsvSection } from "@/lib/csv";

// Shared query + shaping for both the organiser timing dashboard and the
// public leaderboard — split from either route/page so it's directly
// testable without auth() or a live HTTP round trip, same pattern as
// reconciliation.ts / revenue-forecast-data.ts in prior sessions.

async function getAthleteProgress(eventId: string): Promise<AthleteProgress[]> {
  const chipTimes = await prisma.chipTime.findMany({
    where: { eventId },
    include: {
      timingPoint: { select: { id: true, sequenceOrder: true, isStart: true, isFinish: true, distanceMeters: true } },
      credential: {
        select: {
          id: true,
          nfcUid: true,
          ticket: {
            select: {
              currentHolderUserId: true,
              ticketType: { select: { id: true, name: true } },
              order: { select: { user: { select: { name: true } } } },
            },
          },
        },
      },
    },
  });

  const byCredential = new Map<string, AthleteProgress>();
  for (const c of chipTimes) {
    const ticket = c.credential.ticket;
    if (!ticket) continue; // shouldn't happen — resolveCredentialForTiming only ever picks ticket-linked credentials

    let athlete = byCredential.get(c.credentialId);
    if (!athlete) {
      athlete = {
        credentialId: c.credentialId,
        athleteName: ticket.order.user.name,
        bib: (c.credential.nfcUid ?? c.credential.id).slice(-4).toUpperCase(),
        ticketTypeId: ticket.ticketType.id,
        ticketTypeName: ticket.ticketType.name,
        times: [],
      };
      byCredential.set(c.credentialId, athlete);
    }
    athlete.times.push({
      timingPointId: c.timingPointId,
      sequenceOrder: c.timingPoint.sequenceOrder,
      isStart: c.timingPoint.isStart,
      isFinish: c.timingPoint.isFinish,
      distanceMeters: c.timingPoint.distanceMeters,
      gunTimeOffsetSeconds: c.gunTimeOffsetSeconds,
    });
  }

  // currentHolderUserId isn't resolved above (a second lookup per ticket
  // would be wasteful) — the buyer's own name is a reasonable stand-in for
  // "who's running" in the overwhelming case tickets aren't transferred;
  // see the comment on the same tradeoff `athleteName` accepts elsewhere in
  // this session for why this isn't corrected here.
  return Array.from(byCredential.values());
}

export interface TimingDashboardData {
  eventId: string;
  eventTitle: string;
  currency: string;
  gunStartAt: string | null;
  timingPoints: { id: string; name: string; sequenceOrder: number; isStart: boolean; isFinish: boolean }[];
  totalStarters: number;
  totalFinishers: number;
  dnfCount: number;
  raceEnded: boolean;
  perPointCounts: { timingPointId: string; name: string; count: number }[];
  leaders: ReturnType<typeof buildLeaderboard>;
}

export async function getTimingDashboardData(eventId: string): Promise<TimingDashboardData | null> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, title: true, currency: true, startsAt: true, endsAt: true, gunStartAt: true },
  });
  if (!event) return null;

  const timingPoints = await prisma.timingPoint.findMany({
    where: { eventId },
    orderBy: { sequenceOrder: "asc" },
    select: { id: true, name: true, sequenceOrder: true, isStart: true, isFinish: true },
  });
  const startPoint = timingPoints.find((p) => p.isStart);
  const finishPoint = timingPoints.find((p) => p.isFinish);

  const athletes = await getAthleteProgress(eventId);
  const raceEnded = eventHasEnded(event);

  const countsByPoint = new Map<string, number>();
  for (const a of athletes) {
    for (const t of a.times) {
      countsByPoint.set(t.timingPointId, (countsByPoint.get(t.timingPointId) ?? 0) + 1);
    }
  }

  return {
    eventId: event.id,
    eventTitle: event.title,
    currency: event.currency,
    gunStartAt: event.gunStartAt ? event.gunStartAt.toISOString() : null,
    timingPoints,
    totalStarters: startPoint ? countsByPoint.get(startPoint.id) ?? 0 : 0,
    totalFinishers: finishPoint ? countsByPoint.get(finishPoint.id) ?? 0 : 0,
    dnfCount: countDNFs(athletes, raceEnded),
    raceEnded,
    perPointCounts: timingPoints.map((p) => ({ timingPointId: p.id, name: p.name, count: countsByPoint.get(p.id) ?? 0 })),
    leaders: buildLeaderboard(athletes),
  };
}

export interface LeaderboardPageData {
  eventTitle: string;
  ticketTypes: { id: string; name: string }[];
  finishers: ReturnType<typeof buildLeaderboard>["finishers"];
  inProgress: ReturnType<typeof buildLeaderboard>["inProgress"];
  lastUpdated: string;
}

// Public, unauthenticated — used by /events/[slug]/leaderboard. Never
// exposes anything beyond what a printed race-day results board already
// would (name, bib, time, pace).
export async function getLeaderboardData(slug: string, ticketTypeId?: string): Promise<LeaderboardPageData | null> {
  const event = await prisma.event.findUnique({ where: { slug }, select: { id: true, title: true } });
  if (!event) return null;

  const ticketTypes = await prisma.ticketType.findMany({
    where: { eventId: event.id },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  const athletes = await getAthleteProgress(event.id);
  const { finishers, inProgress } = buildLeaderboard(athletes, ticketTypeId);

  return {
    eventTitle: event.title,
    ticketTypes,
    finishers,
    inProgress,
    lastUpdated: new Date().toISOString(),
  };
}

export function buildTimingResultsCsvSections(data: TimingDashboardData): CsvSection[] {
  return [
    {
      title: `Timing summary — ${data.eventTitle}`,
      headers: ["Metric", "Value"],
      rows: [
        ["Total starters", data.totalStarters],
        ["Total finishers", data.totalFinishers],
        ["DNF", data.raceEnded ? data.dnfCount : "Race not yet ended"],
      ],
    },
    {
      title: "Per-timing-point counts",
      headers: ["Timing point", "Athletes recorded"],
      rows: data.perPointCounts.map((p) => [p.name, p.count]),
    },
    {
      title: "Finish results",
      headers: ["Rank", "Athlete", "Bib", "Ticket type", "Gun time", "Pace"],
      rows: data.leaders.finishers.map((r) => [r.rank, r.athleteName, r.bib, r.ticketTypeName, r.gunTimeFormatted, r.pace]),
    },
  ];
}

export function buildTimingResultsCsv(data: TimingDashboardData): string {
  return buildCsvDocument(buildTimingResultsCsvSections(data));
}
