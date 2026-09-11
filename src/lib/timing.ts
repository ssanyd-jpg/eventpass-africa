// Pure, DB-free time math for Session 12's marathon chip timing — same
// testability convention as forecast.ts/analytics.ts: no Prisma, no fetch.
// Used by both handleRecordChipTime (server, authoritative) and the timing
// scanner page (client, optimistic display before a tap has synced).

// Gun time is always non-negative — a tap recorded before the gun (clock
// skew, or a device offline since before the start) floors to 0 rather
// than showing a negative elapsed time.
export function computeGunTimeOffsetSeconds(gunStartAt: Date | null, recordedAt: Date): number | null {
  if (!gunStartAt) return null;
  return Math.max(0, Math.round((recordedAt.getTime() - gunStartAt.getTime()) / 1000));
}

export function computeSplitTimeSeconds(recordedAt: Date, previousRecordedAt: Date | null): number | null {
  if (!previousRecordedAt) return null;
  return Math.max(0, Math.round((recordedAt.getTime() - previousRecordedAt.getTime()) / 1000));
}

export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

// Seconds per km — null when the timing point's distance isn't known
// (distanceMeters is optional; not every organiser tracks intermediate
// course distances). The leaderboard shows "—" for pace in that case.
export function computePaceSecondsPerKm(elapsedSeconds: number, distanceMeters: number | null | undefined): number | null {
  if (!distanceMeters || distanceMeters <= 0 || elapsedSeconds <= 0) return null;
  const km = distanceMeters / 1000;
  return Math.round(elapsedSeconds / km);
}

export function formatPace(paceSecondsPerKm: number | null): string {
  if (paceSecondsPerKm == null) return "—";
  const m = Math.floor(paceSecondsPerKm / 60);
  const s = paceSecondsPerKm % 60;
  return `${m}:${String(s).padStart(2, "0")} /km`;
}
