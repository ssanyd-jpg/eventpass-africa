import type { LineSeriesPoint } from "@/components/charts/LineSeries";

// Pure, DB-free deterministic projections for the pre-event revenue
// forecasting page (Session 10). Distinct from src/lib/forecast.ts, which
// extrapolates from ACTUAL sales velocity once tickets are selling — this
// module takes the organiser's own pre-event assumptions and fans them out
// into Low / Base / High scenarios. Same testability convention as
// forecast.ts/analytics.ts: no Prisma, no fetch, plain inputs in.

export const NET_BREAKAGE_RATE = 0.05; // unspent-then-forfeited share of top-ups
export const PLATFORM_REVENUE_RATE = 0.02; // platform's cut of cashless volume

export type ScenarioKey = "low" | "base" | "high";

// Low/High pin cashless adoption to a fixed rate; Base uses the organiser's
// own inputted rate. Attendance and spend are multipliers on the inputs.
export const SCENARIOS: Record<
  ScenarioKey,
  { label: string; attendanceMultiplier: number; adoptionRate: number | null; spendMultiplier: number }
> = {
  low: { label: "Low", attendanceMultiplier: 0.7, adoptionRate: 0.4, spendMultiplier: 0.8 },
  base: { label: "Base", attendanceMultiplier: 1.0, adoptionRate: null, spendMultiplier: 1.0 },
  high: { label: "High", attendanceMultiplier: 1.2, adoptionRate: 0.8, spendMultiplier: 1.2 },
};

export interface ForecastInputs {
  expectedAttendance: number;
  cashlessAdoptionRate: number; // 0..1, used as-is for the Base scenario
  avgSpendCents: number; // average wallet top-up per cashless attendee
  durationDays: number;
}

export interface TicketTier {
  priceCents: number;
  quantityTotal: number; // capacity — used to pro-rate projected attendance across tiers
}

export interface ScenarioProjection {
  key: ScenarioKey;
  label: string;
  projectedAttendance: number;
  cashlessAttendees: number;
  ticketRevenueCents: number;
  topUpVolumeCents: number;
  cashlessSpendCents: number;
  netBreakageCents: number;
  platformRevenueCents: number;
  totalRevenueCents: number;
}

// Distribute a projected attendance figure across the tiers in proportion
// to each tier's share of total capacity, then value it at each tier's
// price. Not capped at capacity — the High scenario deliberately models
// 120% of expected attendance, and this is a what-if projection, not an
// inventory check.
function projectedTicketRevenueCents(tiers: TicketTier[], projectedAttendance: number): number {
  const totalCapacity = tiers.reduce((sum, t) => sum + t.quantityTotal, 0);
  if (totalCapacity <= 0) return 0;
  return tiers.reduce((sum, t) => {
    const tierAttendance = projectedAttendance * (t.quantityTotal / totalCapacity);
    return sum + t.priceCents * tierAttendance;
  }, 0);
}

export function computeScenario(inputs: ForecastInputs, tiers: TicketTier[], key: ScenarioKey): ScenarioProjection {
  const s = SCENARIOS[key];
  const projectedAttendance = Math.round(inputs.expectedAttendance * s.attendanceMultiplier);
  const adoptionRate = s.adoptionRate ?? inputs.cashlessAdoptionRate;
  const cashlessAttendees = Math.round(projectedAttendance * adoptionRate);

  const ticketRevenueCents = Math.round(projectedTicketRevenueCents(tiers, projectedAttendance));

  // "Average spend per cashless attendee" is treated as the top-up amount
  // (what they load onto the wallet). Of that, NET_BREAKAGE_RATE is never
  // spent (forfeited breakage) and the rest is real vendor spend — so the
  // three cashless lines always reconcile: topUp = spend + breakage.
  const perHeadCents = inputs.avgSpendCents * s.spendMultiplier;
  const topUpVolumeCents = Math.round(cashlessAttendees * perHeadCents);
  const netBreakageCents = Math.round(topUpVolumeCents * NET_BREAKAGE_RATE);
  const cashlessSpendCents = topUpVolumeCents - netBreakageCents;
  const platformRevenueCents = Math.round(topUpVolumeCents * PLATFORM_REVENUE_RATE);

  // Gross revenue processed through the event: ticket sales plus the full
  // cashless top-up float. The spend/breakage/platform lines are a
  // breakdown of the cashless portion, not additional addends.
  const totalRevenueCents = ticketRevenueCents + topUpVolumeCents;

  return {
    key,
    label: s.label,
    projectedAttendance,
    cashlessAttendees,
    ticketRevenueCents,
    topUpVolumeCents,
    cashlessSpendCents,
    netBreakageCents,
    platformRevenueCents,
    totalRevenueCents,
  };
}

export interface ForecastResult {
  scenarios: Record<ScenarioKey, ScenarioProjection>;
  // Projected total (Base scenario) revenue spread across the event's days
  // — flat for a single-day event, a gentle ramp for multi-day.
  dailyCurve: LineSeriesPoint[];
}

// Weights for the daily ramp on a multi-day event: day 1 lightest, rising
// to a peak, easing on the final day. Normalised so the curve sums to the
// scenario total regardless of duration.
function dayWeights(days: number): number[] {
  if (days <= 1) return [1];
  const raw = Array.from({ length: days }, (_, i) => {
    const t = i / (days - 1); // 0..1
    // rise to ~0.8 of the way through, then taper
    return 0.6 + Math.sin(Math.min(t, 0.8) / 0.8 * (Math.PI / 2)) * 0.8 - Math.max(0, t - 0.8) * 1.5;
  });
  const min = Math.min(...raw);
  const shifted = raw.map((w) => Math.max(0.2, w - Math.min(0, min)));
  const sum = shifted.reduce((a, b) => a + b, 0);
  return shifted.map((w) => w / sum);
}

export function projectedDailyRevenue(totalCents: number, durationDays: number): LineSeriesPoint[] {
  const days = Math.max(1, Math.round(durationDays));
  const weights = dayWeights(days);
  return weights.map((w, i) => ({ label: `Day ${i + 1}`, value: Math.round(totalCents * w) }));
}

export function computeForecast(inputs: ForecastInputs, tiers: TicketTier[]): ForecastResult {
  const scenarios = {
    low: computeScenario(inputs, tiers, "low"),
    base: computeScenario(inputs, tiers, "base"),
    high: computeScenario(inputs, tiers, "high"),
  };
  return {
    scenarios,
    dailyCurve: projectedDailyRevenue(scenarios.base.totalRevenueCents, inputs.durationDays),
  };
}

// ---------- historical comparison ----------

export interface PastEventPerformance {
  ticketHolders: number; // distinct attendees (tickets on PAID/NEEDS_REVIEW orders)
  walletCount: number; // attendees who loaded a wallet
  topUpVolumeCents: number; // COMPLETED TOPUP volume
}

export interface HistoricalSummary {
  eventCount: number;
  avgCashlessAdoptionRate: number | null; // 0..1, null when no comparable history
  avgSpendPerHeadCents: number | null; // per cashless attendee
}

// Averages the per-event adoption rate (wallets / ticket holders) and spend
// per cashless head (top-up volume / wallets) across the organiser's past
// events. Events with no ticket holders are skipped (no meaningful rate).
export function summarizeHistoricalPerformance(events: PastEventPerformance[]): HistoricalSummary {
  const usable = events.filter((e) => e.ticketHolders > 0);
  if (usable.length === 0) {
    return { eventCount: events.length, avgCashlessAdoptionRate: null, avgSpendPerHeadCents: null };
  }

  const adoptionRates = usable.map((e) => e.walletCount / e.ticketHolders);
  const avgCashlessAdoptionRate = adoptionRates.reduce((a, b) => a + b, 0) / usable.length;

  const withWallets = usable.filter((e) => e.walletCount > 0);
  const avgSpendPerHeadCents =
    withWallets.length > 0
      ? Math.round(
          withWallets.reduce((sum, e) => sum + e.topUpVolumeCents / e.walletCount, 0) / withWallets.length
        )
      : null;

  return { eventCount: events.length, avgCashlessAdoptionRate, avgSpendPerHeadCents };
}
