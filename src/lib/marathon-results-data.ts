import { prisma } from "@/lib/prisma";
import { rankResults, type RawMarathonFinisher, type RankedMarathonFinisher, type DNFAthlete } from "@/lib/marathon-results";

// Shared query — every ChipTime tap for the event, joined up to the
// athlete's name/category and grouped by credential. getMarathonResults,
// getDNFs and getMarathonRaceCounts all derive from the same shape rather
// than each re-querying, same "one join, several derived views" approach
// getAthleteProgress in timing-data.ts takes (not reused directly — this
// session doesn't modify existing session files, so this is its own
// independent query rather than an export added to that file).

interface AthleteTap {
  timingPointId: string;
  isStart: boolean;
  isFinish: boolean;
  distanceMeters: number | null;
  gunTimeOffsetSeconds: number | null;
}

interface AthleteRaceRecord {
  credentialId: string;
  athleteName: string;
  bib: string;
  ticketTypeName: string;
  taps: AthleteTap[];
}

async function getAthleteRaceRecords(eventId: string): Promise<AthleteRaceRecord[]> {
  const chipTimes = await prisma.chipTime.findMany({
    where: { eventId },
    select: {
      gunTimeOffsetSeconds: true,
      timingPointId: true,
      timingPoint: { select: { isStart: true, isFinish: true, distanceMeters: true } },
      credentialId: true,
      credential: {
        select: {
          nfcUid: true,
          ticket: {
            select: {
              ticketType: { select: { name: true } },
              order: { select: { user: { select: { name: true } } } },
            },
          },
        },
      },
    },
  });

  const byCredential = new Map<string, AthleteRaceRecord>();
  for (const c of chipTimes) {
    const ticket = c.credential.ticket;
    if (!ticket) continue; // shouldn't happen — chip taps only ever resolve to ticket-linked credentials

    let record = byCredential.get(c.credentialId);
    if (!record) {
      record = {
        credentialId: c.credentialId,
        athleteName: ticket.order.user.name,
        bib: (c.credential.nfcUid ?? c.credentialId).slice(-4).toUpperCase(),
        ticketTypeName: ticket.ticketType.name,
        taps: [],
      };
      byCredential.set(c.credentialId, record);
    }
    record.taps.push({
      timingPointId: c.timingPointId,
      isStart: c.timingPoint.isStart,
      isFinish: c.timingPoint.isFinish,
      distanceMeters: c.timingPoint.distanceMeters,
      gunTimeOffsetSeconds: c.gunTimeOffsetSeconds,
    });
  }
  return Array.from(byCredential.values());
}

export async function getMarathonResults(eventId: string): Promise<RankedMarathonFinisher[]> {
  const records = await getAthleteRaceRecords(eventId);

  const raw: RawMarathonFinisher[] = [];
  for (const r of records) {
    const finish = r.taps.find((t) => t.isFinish);
    if (!finish || finish.gunTimeOffsetSeconds == null) continue;

    const start = r.taps.find((t) => t.isStart);
    const netDiff = start?.gunTimeOffsetSeconds != null ? finish.gunTimeOffsetSeconds - start.gunTimeOffsetSeconds : null;

    raw.push({
      credentialId: r.credentialId,
      athleteName: r.athleteName,
      bib: r.bib,
      ticketTypeName: r.ticketTypeName,
      gunTimeOffsetSeconds: finish.gunTimeOffsetSeconds,
      chipTimeOffsetSeconds: netDiff != null && netDiff > 0 ? netDiff : null,
      distanceMeters: finish.distanceMeters,
    });
  }

  return rankResults(raw);
}

export async function getDNFs(eventId: string): Promise<DNFAthlete[]> {
  const records = await getAthleteRaceRecords(eventId);
  return records
    .filter((r) => r.taps.some((t) => t.isStart) && !r.taps.some((t) => t.isFinish))
    .map((r) => ({ athleteName: r.athleteName, bib: r.bib, ticketTypeName: r.ticketTypeName }));
}

export interface MarathonRaceCounts {
  totalStarters: number;
  totalFinishers: number;
  dnfCount: number;
}

export async function getMarathonRaceCounts(eventId: string): Promise<MarathonRaceCounts> {
  const records = await getAthleteRaceRecords(eventId);
  return {
    totalStarters: records.filter((r) => r.taps.some((t) => t.isStart)).length,
    totalFinishers: records.filter((r) => r.taps.some((t) => t.isFinish)).length,
    dnfCount: records.filter((r) => r.taps.some((t) => t.isStart) && !r.taps.some((t) => t.isFinish)).length,
  };
}

export interface MarathonResultsBundle {
  eventId: string;
  eventTitle: string;
  venue: string;
  city: string;
  startsAt: Date;
  results: RankedMarathonFinisher[];
  dnfs: DNFAthlete[];
  counts: MarathonRaceCounts;
}

// Public, unauthenticated — powers /events/[slug]/results. Same fields the
// public leaderboard already exposes (name, bib, category, times, pace),
// nothing an order/account page would (email, phone, ticket price) — same
// discipline as getLeaderboardData in timing-data.ts.
export async function getPublicMarathonResults(slug: string): Promise<MarathonResultsBundle | null> {
  const event = await prisma.event.findUnique({
    where: { slug },
    select: { id: true, title: true, venue: true, city: true, startsAt: true },
  });
  if (!event) return null;

  const [results, dnfs, counts] = await Promise.all([
    getMarathonResults(event.id),
    getDNFs(event.id),
    getMarathonRaceCounts(event.id),
  ]);

  return { eventId: event.id, eventTitle: event.title, venue: event.venue, city: event.city, startsAt: event.startsAt, results, dnfs, counts };
}
