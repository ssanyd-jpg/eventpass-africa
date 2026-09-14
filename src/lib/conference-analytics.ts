// Pure, DB-free shaping functions for CONFERENCE analytics — same
// separation-of-concerns discipline analytics.ts itself already follows
// (Prisma queries live in conference-analytics-data.ts, this file just
// shapes already-fetched rows so it's directly testable without a database).

const HOUR_MS = 60 * 60 * 1000;

// Floors to the top of the hour, in local time — same convention
// analytics.ts's own startOfHourMs/formatHourLabel use.
function startOfHourMs(date: Date): number {
  const d = new Date(date);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

function formatHourLabel(ms: number): string {
  return `${String(new Date(ms).getHours()).padStart(2, "0")}:00`;
}

export interface SessionHourPoint {
  hour: string; // "09:00"
  count: number;
}

export interface SessionHourlyStats {
  sessionId: string;
  sessionName: string;
  hours: SessionHourPoint[];
}

// Heat-map grid: attendance taps grouped by session and by hour of day —
// same shape/reasoning as transactionsByVendorByHour in analytics.ts
// (Session 2's own heat map pattern), reused here for "which sessions were
// most attended, and when" instead of vendor sales. Zero-filled across one
// shared hour range (event start through now/latest tap) so every session's
// row shares one column set, same as transactionsByVendorByHour's own
// zero-fill discipline.
export function attendanceBySessionByHour(
  attendances: { eventSessionId: string; recordedAt: Date }[],
  sessions: { id: string; name: string }[],
  rangeStart: Date,
  now: Date = new Date()
): SessionHourlyStats[] {
  const startHour = startOfHourMs(rangeStart);
  const latest = attendances.reduce((max, a) => Math.max(max, a.recordedAt.getTime()), now.getTime());
  const endHour = Math.max(startOfHourMs(new Date(latest)), startHour);
  const hourKeys: number[] = [];
  for (let t = startHour; t <= endHour; t += HOUR_MS) hourKeys.push(t);

  const bySession = new Map<string, Map<number, number>>();
  for (const a of attendances) {
    const totals = bySession.get(a.eventSessionId) ?? new Map<number, number>();
    const key = startOfHourMs(a.recordedAt);
    totals.set(key, (totals.get(key) ?? 0) + 1);
    bySession.set(a.eventSessionId, totals);
  }

  return sessions.map((s) => ({
    sessionId: s.id,
    sessionName: s.name,
    hours: hourKeys.map((key) => ({ hour: formatHourLabel(key), count: bySession.get(s.id)?.get(key) ?? 0 })),
  }));
}

export interface PeakHourStat {
  hour: string;
  count: number;
}

// Which hour-of-day slot had the highest TOTAL attendance across every
// session combined — null only when there's no attendance data at all (a
// brand-new conference with no taps yet), never zero-with-a-label.
export function peakAttendanceHour(attendances: { recordedAt: Date }[]): PeakHourStat | null {
  if (attendances.length === 0) return null;

  const totals = new Map<number, number>();
  for (const a of attendances) {
    const key = startOfHourMs(a.recordedAt);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }

  let bestKey = -1;
  let bestCount = -1;
  for (const [key, count] of Array.from(totals)) {
    if (count > bestCount) {
      bestCount = count;
      bestKey = key;
    }
  }
  return { hour: formatHourLabel(bestKey), count: bestCount };
}

export interface RankedEntry {
  label: string;
  value: number;
}

// Ranked exhibitor lead totals per vendor — same RankedEntry shape as
// sponsorTapsBySponsor/spendByVendor in analytics.ts. Groups by the real
// Vendor FK (id), not a string label, so two leads for the same exhibitor
// always collapse onto one entry.
export function exhibitorLeadTotals(
  leads: { vendor: { id: string; name: string } }[],
  limit = 10
): RankedEntry[] {
  const totals = new Map<string, RankedEntry>();
  for (const l of leads) {
    const entry = totals.get(l.vendor.id) ?? { label: l.vendor.name, value: 0 };
    entry.value += 1;
    totals.set(l.vendor.id, entry);
  }
  return Array.from(totals.values())
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}
