// Pure ranking logic for the public marathon leaderboard and the organiser
// timing dashboard — no Prisma, no fetch, fed the rows the caller already
// queried (see leaderboard-data.ts / timing-data.ts). Same testability
// convention as forecast.ts/analytics.ts.
import { computePaceSecondsPerKm, formatElapsed, formatPace } from "@/lib/timing";

export interface AthletePointTime {
  timingPointId: string;
  sequenceOrder: number;
  isStart: boolean;
  isFinish: boolean;
  distanceMeters: number | null;
  gunTimeOffsetSeconds: number | null;
}

export interface AthleteProgress {
  credentialId: string;
  athleteName: string;
  bib: string; // last 4 of the credential's NFC uid
  ticketTypeId: string;
  ticketTypeName: string;
  times: AthletePointTime[];
}

export interface LeaderboardRow {
  rank: number;
  athleteName: string;
  bib: string;
  ticketTypeName: string;
  gunTimeOffsetSeconds: number;
  gunTimeFormatted: string;
  pace: string;
  lastPointName?: string; // in-progress rows only
}

export interface LeaderboardResult {
  finishers: LeaderboardRow[];
  inProgress: LeaderboardRow[];
}

function latestTime(athlete: AthleteProgress): AthletePointTime | null {
  return athlete.times.reduce<AthletePointTime | null>((latest, t) => {
    if (!latest || t.sequenceOrder > latest.sequenceOrder) return t;
    return latest;
  }, null);
}

// Finishers ranked by finish gun time (fastest first); everyone else who
// has at least one recorded tap ranked by how far around the course
// they've gotten (furthest timing point first, then fastest at that point)
// — "current leaders... on course" per the Session 12 spec. Optionally
// scoped to one ticket type (race category).
export function buildLeaderboard(
  athletes: AthleteProgress[],
  ticketTypeId?: string
): LeaderboardResult {
  const scoped = ticketTypeId ? athletes.filter((a) => a.ticketTypeId === ticketTypeId) : athletes;

  const finished: { athlete: AthleteProgress; time: AthletePointTime }[] = [];
  const onCourse: { athlete: AthleteProgress; time: AthletePointTime }[] = [];

  for (const athlete of scoped) {
    const finish = athlete.times.find((t) => t.isFinish);
    if (finish && finish.gunTimeOffsetSeconds != null) {
      finished.push({ athlete, time: finish });
      continue;
    }
    const latest = latestTime(athlete);
    if (latest && latest.gunTimeOffsetSeconds != null) {
      onCourse.push({ athlete, time: latest });
    }
  }

  finished.sort((a, b) => a.time.gunTimeOffsetSeconds! - b.time.gunTimeOffsetSeconds!);
  onCourse.sort((a, b) => {
    if (b.time.sequenceOrder !== a.time.sequenceOrder) return b.time.sequenceOrder - a.time.sequenceOrder;
    return a.time.gunTimeOffsetSeconds! - b.time.gunTimeOffsetSeconds!;
  });

  const toRow = (a: AthleteProgress, t: AthletePointTime, rank: number): LeaderboardRow => {
    const gun = t.gunTimeOffsetSeconds!;
    return {
      rank,
      athleteName: a.athleteName,
      bib: a.bib,
      ticketTypeName: a.ticketTypeName,
      gunTimeOffsetSeconds: gun,
      gunTimeFormatted: formatElapsed(gun),
      pace: formatPace(computePaceSecondsPerKm(gun, t.distanceMeters)),
    };
  };

  return {
    finishers: finished.map(({ athlete, time }, i) => toRow(athlete, time, i + 1)),
    inProgress: onCourse.map(({ athlete, time }, i) => ({ ...toRow(athlete, time, i + 1), lastPointName: undefined })),
  };
}

// DNF = started but has no finish recorded, evaluated only once the race
// has actually ended (Event.endsAt in the past — see eventHasEnded in
// carry-over.ts, reused for the same "has this event actually finished"
// question). Calling this before the race has ended would misclassify
// every athlete still out on the course as a DNF, so callers must gate on
// raceEnded themselves.
export function countDNFs(athletes: AthleteProgress[], raceEnded: boolean): number {
  if (!raceEnded) return 0;
  return athletes.filter((a) => a.times.some((t) => t.isStart) && !a.times.some((t) => t.isFinish)).length;
}
