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

// Top organizations by revenue — one ranked list per currency (the same
// rule that forbids summing revenue across currencies also forbids ranking
// organizations against each other across them).
export function topOrganizersByRevenue(
  orders: { totalCents: number; currency: string; event: { organizationId: string; organization: { name: string } } }[],
  limit = 5
): Record<string, RankedEntry[]> {
  const byCurrency = new Map<string, Map<string, RankedEntry>>();
  for (const o of orders) {
    const organizerMap = byCurrency.get(o.currency) ?? new Map<string, RankedEntry>();
    const key = o.event.organizationId;
    const entry = organizerMap.get(key) ?? { label: o.event.organization.name, value: 0 };
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

export interface WalletBalanceStats {
  walletCount: number;
  outstandingBalanceByCurrency: Record<string, number>;
}

export function summarizeWalletBalances(
  wallets: { balanceCents: number; currency: string }[]
): WalletBalanceStats {
  const outstandingBalanceByCurrency: Record<string, number> = {};
  for (const w of wallets) {
    outstandingBalanceByCurrency[w.currency] = (outstandingBalanceByCurrency[w.currency] ?? 0) + w.balanceCents;
  }
  return { walletCount: wallets.length, outstandingBalanceByCurrency };
}

export interface WalletActivityStats {
  topupVolumeByCurrency: Record<string, number>;
  spendVolumeByCurrency: Record<string, number>;
  sponsorTapCount: number;
}

// Only COMPLETED rows count toward volume — a PENDING top-up hasn't
// actually landed yet, and a FAILED/declined sale never moved any balance.
export function summarizeWalletActivity(
  txs: { type: string; status: string; amountCents: number | null; currency: string }[]
): WalletActivityStats {
  const topupVolumeByCurrency: Record<string, number> = {};
  const spendVolumeByCurrency: Record<string, number> = {};
  let sponsorTapCount = 0;

  for (const t of txs) {
    if (t.type === "TOPUP" && t.status === "COMPLETED") {
      topupVolumeByCurrency[t.currency] = (topupVolumeByCurrency[t.currency] ?? 0) + (t.amountCents ?? 0);
    } else if (t.type === "SALE" && t.status === "COMPLETED") {
      spendVolumeByCurrency[t.currency] = (spendVolumeByCurrency[t.currency] ?? 0) + (t.amountCents ?? 0);
    } else if (t.type === "SPONSOR_TAP") {
      sponsorTapCount += 1;
    }
  }

  return { topupVolumeByCurrency, spendVolumeByCurrency, sponsorTapCount };
}

// Same currency-partitioned ranked-list shape as topOrganizersByRevenue —
// spend can't be compared across currencies either.
export function spendByVendor(
  txs: { type: string; status: string; amountCents: number | null; currency: string; vendor: { id: string; name: string } | null }[],
  limit = 5
): Record<string, RankedEntry[]> {
  const byCurrency = new Map<string, Map<string, RankedEntry>>();
  for (const t of txs) {
    if (t.type !== "SALE" || t.status !== "COMPLETED" || !t.vendor) continue;
    const vendorMap = byCurrency.get(t.currency) ?? new Map<string, RankedEntry>();
    const entry = vendorMap.get(t.vendor.id) ?? { label: t.vendor.name, value: 0 };
    entry.value += t.amountCents ?? 0;
    vendorMap.set(t.vendor.id, entry);
    byCurrency.set(t.currency, vendorMap);
  }
  const result: Record<string, RankedEntry[]> = {};
  for (const [currency, vendorMap] of Array.from(byCurrency)) {
    result[currency] = Array.from(vendorMap.values())
      .sort((a, b) => b.value - a.value)
      .slice(0, limit);
  }
  return result;
}

export interface CustomerStat {
  userId: string;
  name: string;
  email: string;
  ordersCount: number;
  totalCentsByCurrency: Record<string, number>; // never summed across currencies
  lastOrderAt: Date;
}

// Groups an organization's orders by buyer into lifetime stats. Caller is
// responsible for pre-scoping/filtering (org-scoped, status-filtered) — this
// function doesn't re-filter, it only aggregates, same convention every
// other bucket/summarize function in this file follows.
export function customerStatsByBuyer(
  orders: { userId: string; user: { name: string; email: string }; totalCents: number; currency: string; createdAt: Date }[]
): CustomerStat[] {
  const byUser = new Map<string, CustomerStat>();
  for (const o of orders) {
    const existing = byUser.get(o.userId) ?? {
      userId: o.userId,
      name: o.user.name,
      email: o.user.email,
      ordersCount: 0,
      totalCentsByCurrency: {},
      lastOrderAt: o.createdAt,
    };
    existing.ordersCount += 1;
    existing.totalCentsByCurrency[o.currency] = (existing.totalCentsByCurrency[o.currency] ?? 0) + o.totalCents;
    if (o.createdAt > existing.lastOrderAt) existing.lastOrderAt = o.createdAt;
    byUser.set(o.userId, existing);
  }
  return Array.from(byUser.values()).sort((a, b) => b.lastOrderAt.getTime() - a.lastOrderAt.getTime());
}

// Plain count, no currency involved — same reasoning as topEventsByTicketsSold.
// Groups by the real Sponsor FK (id), not a string label, so two taps for the
// same sponsor always collapse onto one entry.
export function sponsorTapsBySponsor(
  txs: { type: string; sponsor: { id: string; name: string } | null }[],
  limit = 10
): RankedEntry[] {
  const totals = new Map<string, RankedEntry>();
  for (const t of txs) {
    if (t.type !== "SPONSOR_TAP" || !t.sponsor) continue;
    const entry = totals.get(t.sponsor.id) ?? { label: t.sponsor.name, value: 0 };
    entry.value += 1;
    totals.set(t.sponsor.id, entry);
  }
  return Array.from(totals.values())
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

const HOUR_MS = 60 * 60 * 1000;

// Floors to the top of the hour, in local time — same "this codebase never
// does timezone-aware bucketing" convention bucketByDay already follows
// with startOfDay.
function startOfHourMs(date: Date): number {
  const d = new Date(date);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

function formatHourLabel(ms: number): string {
  return `${String(new Date(ms).getHours()).padStart(2, "0")}:00`;
}

export interface HourPoint {
  hour: string; // "09:00"
  count: number; // arrivals in this hour only
  cumulative: number; // running total through this hour, inclusive
}

// Zero-filled hourly check-in series, from the event's start hour through
// `now` (or the latest actual check-in, if later — a defensive floor, not
// the expected case) — same zero-fill philosophy as bucketByDay, extended
// to carry both the per-hour arrival rate and the running total so callers
// can show either without recomputing from the other.
export function checkInsByHour(
  tickets: { checkedInAt: Date | null }[],
  eventStartsAt: Date,
  now: Date = new Date()
): HourPoint[] {
  const checkedInTimes = tickets
    .map((t) => t.checkedInAt)
    .filter((d): d is Date => d !== null);

  const startHour = startOfHourMs(eventStartsAt);
  const latest = checkedInTimes.reduce((max, d) => (d.getTime() > max ? d.getTime() : max), now.getTime());
  const endHour = Math.max(startOfHourMs(new Date(latest)), startHour);

  const totals = new Map<number, number>();
  for (const d of checkedInTimes) {
    const key = startOfHourMs(d);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }

  const series: HourPoint[] = [];
  let cumulative = 0;
  for (let t = startHour; t <= endHour; t += HOUR_MS) {
    const count = totals.get(t) ?? 0;
    cumulative += count;
    series.push({ hour: formatHourLabel(t), count, cumulative });
  }
  return series;
}

export interface VendorHourPoint {
  hour: string;
  count: number;
  amountCents: number;
}

export interface VendorHourlyStats {
  vendorName: string;
  hours: VendorHourPoint[];
}

// Heat-map grid data: completed SALE transactions grouped by vendor and by
// hour of day. Zero-filled across the SAME hour range as checkInsByHour
// (event start through now/latest activity) so every vendor's row shares
// one column set — a grid needs aligned columns, unlike a plain ranked
// list. Single amountCents total per cell, not split by currency: unlike
// the cross-event rankings elsewhere in this file, every wallet on one
// event shares that event's one currency, so there's nothing to split.
export function transactionsByVendorByHour(
  txs: {
    type: string;
    status: string;
    amountCents: number | null;
    createdAt: Date;
    vendor: { id: string; name: string } | null;
  }[],
  eventStartsAt: Date,
  now: Date = new Date()
): VendorHourlyStats[] {
  const sales = txs.filter((t) => t.type === "SALE" && t.status === "COMPLETED" && t.vendor);

  const startHour = startOfHourMs(eventStartsAt);
  const latest = sales.reduce((max, t) => (t.createdAt.getTime() > max ? t.createdAt.getTime() : max), now.getTime());
  const endHour = Math.max(startOfHourMs(new Date(latest)), startHour);
  const hourKeys: number[] = [];
  for (let t = startHour; t <= endHour; t += HOUR_MS) hourKeys.push(t);

  const byVendor = new Map<string, { name: string; totals: Map<number, { count: number; amountCents: number }> }>();
  for (const t of sales) {
    const vendor = t.vendor!;
    const entry = byVendor.get(vendor.id) ?? { name: vendor.name, totals: new Map() };
    const key = startOfHourMs(t.createdAt);
    const bucket = entry.totals.get(key) ?? { count: 0, amountCents: 0 };
    bucket.count += 1;
    bucket.amountCents += t.amountCents ?? 0;
    entry.totals.set(key, bucket);
    byVendor.set(vendor.id, entry);
  }

  return Array.from(byVendor.values()).map((v) => ({
    vendorName: v.name,
    hours: hourKeys.map((key) => {
      const bucket = v.totals.get(key) ?? { count: 0, amountCents: 0 };
      return { hour: formatHourLabel(key), count: bucket.count, amountCents: bucket.amountCents };
    }),
  }));
}

export interface SponsorHourPoint {
  hour: string; // "09:00"
  count: number;
}

// Same zero-filled hourly bucketing as transactionsByVendorByHour, but for
// SPONSOR_TAP rows already scoped to ONE sponsor by the caller (see
// getSponsorDashboardData) — no amountCents to sum (WalletTransaction's own
// comment: amountCents is null for SPONSOR_TAP), just a tap count per hour
// for the sponsor dashboard's "taps by hour" chart.
export function sponsorTapsByHour(
  taps: { createdAt: Date }[],
  dayStart: Date,
  now: Date = new Date()
): SponsorHourPoint[] {
  const startHour = startOfHourMs(dayStart);
  const latest = taps.reduce((max, t) => (t.createdAt.getTime() > max ? t.createdAt.getTime() : max), now.getTime());
  const endHour = Math.max(startOfHourMs(new Date(latest)), startHour);

  const totals = new Map<number, number>();
  for (const t of taps) {
    const key = startOfHourMs(t.createdAt);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }

  const series: SponsorHourPoint[] = [];
  for (let t = startHour; t <= endHour; t += HOUR_MS) {
    series.push({ hour: formatHourLabel(t), count: totals.get(t) ?? 0 });
  }
  return series;
}

export interface LiveEventStats {
  totalCheckedIn: number;
  capacityTotal: number;
  checkInsLast30Min: number;
  totalTopUpCents: number;
  totalSpendCents: number;
  unspentBalanceCents: number;
  activeVendorCount: number;
  lastUpdated: Date;
}

// Single real-time snapshot for a live event-day dashboard. Only COMPLETED
// wallet transactions count toward volume, same convention as
// summarizeWalletActivity. Not split by currency for the same reason as
// transactionsByVendorByHour — one event, one currency.
export function liveEventStats(
  tickets: { checkedIn: boolean; checkedInAt: Date | null }[],
  ticketTypes: { quantityTotal: number }[],
  wallets: { balanceCents: number }[],
  walletTxs: { type: string; status: string; amountCents: number | null; createdAt: Date; vendorId: string | null }[],
  now: Date = new Date()
): LiveEventStats {
  const totalCheckedIn = tickets.filter((t) => t.checkedIn).length;
  const capacityTotal = ticketTypes.reduce((sum, tt) => sum + tt.quantityTotal, 0);

  const thirtyMinAgo = now.getTime() - 30 * 60 * 1000;
  const checkInsLast30Min = tickets.filter(
    (t) => t.checkedInAt !== null && t.checkedInAt.getTime() >= thirtyMinAgo
  ).length;

  const sixtyMinAgo = now.getTime() - 60 * 60 * 1000;
  let totalTopUpCents = 0;
  let totalSpendCents = 0;
  const activeVendorIds = new Set<string>();
  for (const t of walletTxs) {
    if (t.status !== "COMPLETED") continue;
    if (t.type === "TOPUP") {
      totalTopUpCents += t.amountCents ?? 0;
    } else if (t.type === "SALE") {
      totalSpendCents += t.amountCents ?? 0;
      if (t.vendorId && t.createdAt.getTime() >= sixtyMinAgo) activeVendorIds.add(t.vendorId);
    }
  }

  const unspentBalanceCents = wallets.reduce((sum, w) => sum + w.balanceCents, 0);

  return {
    totalCheckedIn,
    capacityTotal,
    checkInsLast30Min,
    totalTopUpCents,
    totalSpendCents,
    unspentBalanceCents,
    activeVendorCount: activeVendorIds.size,
    lastUpdated: now,
  };
}
