// Pure ranking/formatting logic for the official marathon results PDF — no
// Prisma, no fetch, fed the rows the caller already queried (see
// marathon-results-data.ts). Same testability convention as leaderboard.ts/
// forecast.ts.
import { computePaceSecondsPerKm, formatPace, computeAverageSpeedKmh, formatSpeed } from "@/lib/timing";

export interface RawMarathonFinisher {
  credentialId: string;
  athleteName: string;
  bib: string;
  ticketTypeName: string;
  gunTimeOffsetSeconds: number;
  // Net time (finish tap minus this athlete's own start tap) — null when no
  // distinct start tap was recorded, in which case it's the same as gun
  // time and the PDF omits a separate "chip time" column value for them.
  chipTimeOffsetSeconds: number | null;
  distanceMeters: number | null;
}

export interface RankedMarathonFinisher extends RawMarathonFinisher {
  overallRank: number;
  categoryRank: number;
  gunTimeFormatted: string;
  chipTimeFormatted: string | null;
  pace: string;
  // Average speed (km/h) over the same gun time/distance — always computed
  // alongside pace; MOUNTAIN_BIKE events display this column instead of
  // pace (see marathon-results-pdf.ts), everything else keeps showing pace.
  speed: string;
  medal: 1 | 2 | 3 | null;
}

export interface DNFAthlete {
  athleteName: string;
  bib: string;
  ticketTypeName: string;
  // Set when this DNF was explicitly recorded at the finish timing point
  // (see the timing scanner's "Mark as DNF" flow) rather than merely
  // inferred from "started but never tapped finish".
  reason?: string;
}

// "4:22:14" for anything an hour or longer, "6:14" under an hour — a real
// race clock, not the zero-padded HH:MM:SS formatElapsed() uses for the
// live timing dashboard.
export function formatFinishTime(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

// "6:14 /km" — thin wrapper over timing.ts's own pace math so this file
// doesn't duplicate the calculation, just names it per the spec.
export function calculatePace(seconds: number, distanceMeters: number | null | undefined): string {
  return formatPace(computePaceSecondsPerKm(seconds, distanceMeters));
}

// "24.3 km/h" — the MOUNTAIN_BIKE equivalent of calculatePace above, same
// thin-wrapper-over-timing.ts shape.
export function calculateAverageSpeed(distanceMeters: number | null | undefined, seconds: number): string {
  return formatSpeed(computeAverageSpeedKmh(distanceMeters, seconds));
}

// Sorts by gun time ascending (fastest first) and assigns both an overall
// rank and a rank within the athlete's own category (ticket type), same
// pass. Top 3 in each category get `medal` 1/2/3 (gold/silver/bronze) — the
// PDF renderer draws these as colored badges since emoji glyphs can't be
// embedded via a standard PDF font.
export function rankResults(results: RawMarathonFinisher[]): RankedMarathonFinisher[] {
  const sorted = [...results].sort((a, b) => a.gunTimeOffsetSeconds - b.gunTimeOffsetSeconds);

  const categoryCounts = new Map<string, number>();
  return sorted.map((r, i) => {
    const categoryRank = (categoryCounts.get(r.ticketTypeName) ?? 0) + 1;
    categoryCounts.set(r.ticketTypeName, categoryRank);

    const chipDiffers = r.chipTimeOffsetSeconds != null && r.chipTimeOffsetSeconds !== r.gunTimeOffsetSeconds;

    return {
      ...r,
      overallRank: i + 1,
      categoryRank,
      gunTimeFormatted: formatFinishTime(r.gunTimeOffsetSeconds),
      chipTimeFormatted: chipDiffers ? formatFinishTime(r.chipTimeOffsetSeconds!) : null,
      pace: calculatePace(r.gunTimeOffsetSeconds, r.distanceMeters),
      speed: calculateAverageSpeed(r.distanceMeters, r.gunTimeOffsetSeconds),
      medal: categoryRank <= 3 ? (categoryRank as 1 | 2 | 3) : null,
    };
  });
}
