import { startOfDay, subDays, addDays, formatISO } from "date-fns";

// Pure, DB-free shaping functions for the analytics pages — separated from
// the Prisma queries themselves (same separation settlement-handlers.ts
// uses) so this logic is testable without a database.

export const TREND_WINDOW_DAYS = 30;

export function trendWindowStart(days: number = TREND_WINDOW_DAYS): Date {
  return subDays(startOfDay(new Date()), days - 1);
}

export interface DayPoint {
  date: string; // YYYY-MM-DD
  value: number;
}

// Zero-filled day series — every day in the window appears even with no
// activity, so a chart never has a gap a viewer could misread as "no data
// available" rather than "no activity that day."
export function bucketByDay<T>(
  rows: T[],
  getDate: (row: T) => Date,
  getValue: (row: T) => number,
  days: number = TREND_WINDOW_DAYS
): DayPoint[] {
  const start = trendWindowStart(days);
  const totals = new Map<string, number>();
  for (const row of rows) {
    const key = formatISO(startOfDay(getDate(row)), { representation: "date" });
    totals.set(key, (totals.get(key) ?? 0) + getValue(row));
  }
  const series: DayPoint[] = [];
  for (let i = 0; i < days; i++) {
    const key = formatISO(addDays(start, i), { representation: "date" });
    series.push({ date: key, value: totals.get(key) ?? 0 });
  }
  return series;
}

// Splits by currency BEFORE bucketing — keeps the "never sum across
// currencies" rule enforced in exactly one place; bucketByDay itself stays
// currency-blind and reusable for non-money series (ticket counts).
export function bucketRevenueByDay(
  orders: { createdAt: Date; totalCents: number; currency: string }[],
  days: number = TREND_WINDOW_DAYS
): Record<string, DayPoint[]> {
  const byCurrency = new Map<string, typeof orders>();
  for (const o of orders) {
    const group = byCurrency.get(o.currency) ?? [];
    group.push(o);
    byCurrency.set(o.currency, group);
  }
  const result: Record<string, DayPoint[]> = {};
  for (const [currency, group] of Array.from(byCurrency)) {
    result[currency] = bucketByDay(group, (o) => o.createdAt, (o) => o.totalCents, days);
  }
  return result;
}

export interface CheckInStat {
  eventId: string;
  title: string;
  checkedIn: number;
  total: number;
  pct: number;
}

// Reduces a flat Ticket[] (already filtered to non-refunded orders by the
// caller's query) into a per-event check-in rate. Never loops per-event
// queries — one pass over rows already fetched.
export function checkInRateByEvent(
  tickets: { eventId: string; checkedIn: boolean }[],
  events: { id: string; title: string }[]
): CheckInStat[] {
  const totals = new Map<string, { checkedIn: number; total: number }>();
  for (const t of tickets) {
    const bucket = totals.get(t.eventId) ?? { checkedIn: 0, total: 0 };
    bucket.total += 1;
    if (t.checkedIn) bucket.checkedIn += 1;
    totals.set(t.eventId, bucket);
  }
  return events
    .map((e) => {
      const bucket = totals.get(e.id) ?? { checkedIn: 0, total: 0 };
      return {
        eventId: e.id,
        title: e.title,
        checkedIn: bucket.checkedIn,
        total: bucket.total,
        pct: bucket.total > 0 ? Math.round((bucket.checkedIn / bucket.total) * 100) : 0,
      };
    })
    .filter((s) => s.total > 0);
}

export interface SellThroughStat {
  ticketTypeId: string;
  name: string;
  eventTitle: string;
  quantitySold: number;
  quantityTotal: number;
  pct: number;
}

// TicketType.quantitySold is the already-authoritative sold counter
// (atomically maintained in sync-handlers.ts on sell/refund) — this just
// ranks it, it never recomputes it from raw Ticket rows.
export function ticketTypeSellThrough(
  ticketTypes: { id: string; name: string; quantitySold: number; quantityTotal: number; event: { title: string } }[]
): SellThroughStat[] {
  return ticketTypes
    .map((tt) => ({
      ticketTypeId: tt.id,
      name: tt.name,
      eventTitle: tt.event.title,
      quantitySold: tt.quantitySold,
      quantityTotal: tt.quantityTotal,
      pct: tt.quantityTotal > 0 ? Math.round((tt.quantitySold / tt.quantityTotal) * 100) : 0,
    }))
    .sort((a, b) => b.pct - a.pct);
}

export interface VendorStats {
  applications: number;
  approved: number;
  rejected: number;
  pending: number;
  approvalRatePct: number | null; // null when nothing's been decided yet
  feeRevenueByCurrency: Record<string, number>;
}

export function summarizeVendors(
  vendors: { status: string; feeStatus: string; stallFeeCents: number; currency: string }[]
): VendorStats {
  let approved = 0;
  let rejected = 0;
  let pending = 0;
  const feeRevenueByCurrency: Record<string, number> = {};

  for (const v of vendors) {
    if (v.status === "APPROVED") approved += 1;
    else if (v.status === "REJECTED") rejected += 1;
    else pending += 1;

    if (v.feeStatus === "PAID") {
      feeRevenueByCurrency[v.currency] = (feeRevenueByCurrency[v.currency] ?? 0) + v.stallFeeCents;
    }
  }

  const decided = approved + rejected;
  return {
    applications: vendors.length,
    approved,
    rejected,
    pending,
    approvalRatePct: decided > 0 ? Math.round((approved / decided) * 100) : null,
    feeRevenueByCurrency,
  };
}

export interface RankedEntry {
  label: string;
  value: number;
}

// Top organizers by revenue — one ranked list per currency (the same rule
// that forbids summing revenue across currencies also forbids ranking
// organizers against each other across them).
export function topOrganizersByRevenue(
  orders: { totalCents: number; currency: string; event: { organizerId: string; organizer: { name: string } } }[],
  limit = 5
): Record<string, RankedEntry[]> {
  const byCurrency = new Map<string, Map<string, RankedEntry>>();
  for (const o of orders) {
    const organizerMap = byCurrency.get(o.currency) ?? new Map<string, RankedEntry>();
    const key = o.event.organizerId;
    const entry = organizerMap.get(key) ?? { label: o.event.organizer.name, value: 0 };
    entry.value += o.totalCents;
    organizerMap.set(key, entry);
    byCurrency.set(o.currency, organizerMap);
  }
  const result: Record<string, RankedEntry[]> = {};
  for (const [currency, organizerMap] of Array.from(byCurrency)) {
    result[currency] = Array.from(organizerMap.values())
      .sort((a, b) => b.value - a.value)
      .slice(0, limit);
  }
  return result;
}

// Top events by tickets sold — a plain count, no currency involved, so
// (unlike revenue) this is a single unified ranking.
export function topEventsByTicketsSold(
  ticketTypes: { quantitySold: number; event: { id: string; title: string } }[],
  limit = 5
): RankedEntry[] {
  const totals = new Map<string, RankedEntry>();
  for (const tt of ticketTypes) {
    const entry = totals.get(tt.event.id) ?? { label: tt.event.title, value: 0 };
    entry.value += tt.quantitySold;
    totals.set(tt.event.id, entry);
  }
  return Array.from(totals.values())
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}
