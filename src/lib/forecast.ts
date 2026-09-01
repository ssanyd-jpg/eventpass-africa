import { differenceInCalendarDays, startOfDay } from "date-fns";
import { bucketByDay, type DayPoint } from "@/lib/analytics";
import type { BarSeriesPoint } from "@/components/charts/BarSeries";

// Pure, DB-free deterministic heuristics for the per-event dashboard's
// sell-out prediction and revenue forecast — NOT Claude-backed. Numeric/
// statistical questions like these are better served by a small,
// auditable, deterministic formula than by routing raw counts through an
// LLM (see the plan's "core architectural split"). Same testability
// convention as analytics.ts: no Prisma, no fetch, fed plain rows the
// caller already has.

// ---------- sell-out prediction ----------

export type SellOutStatus = "SOLD_OUT" | "LIKELY" | "ON_TRACK" | "SLOW" | "INSUFFICIENT_DATA";

export interface SellOutPrediction {
  ticketTypeId: string;
  name: string;
  status: SellOutStatus;
  predictedSoldOutDate: string | null; // ISO, null if not projected to sell out before the event
  daysUntilEvent: number;
}

const MIN_SALE_DAYS_FOR_SIGNAL = 3;
const VELOCITY_WINDOW_CAP_DAYS = 14;

// velocity = units sold in the trailing window (min(14, days since first
// sale) — a short window so a recent surge is weighted, but never shorter
// than the actual sales history). remaining = quantityTotal - quantitySold.
// daysToSellOut = remaining / (velocity/window).
export function predictSellOut(
  ticketType: { id: string; name: string; quantityTotal: number; quantitySold: number },
  orderItems: { createdAt: Date; quantity: number }[], // this ticket type's line items only
  eventStartsAt: Date,
  now: Date = new Date()
): SellOutPrediction {
  const daysUntilEvent = Math.max(0, differenceInCalendarDays(startOfDay(eventStartsAt), startOfDay(now)));
  const remaining = ticketType.quantityTotal - ticketType.quantitySold;

  if (remaining <= 0) {
    return { ticketTypeId: ticketType.id, name: ticketType.name, status: "SOLD_OUT", predictedSoldOutDate: null, daysUntilEvent };
  }

  if (orderItems.length === 0) {
    return { ticketTypeId: ticketType.id, name: ticketType.name, status: "INSUFFICIENT_DATA", predictedSoldOutDate: null, daysUntilEvent };
  }

  const saleDates = orderItems.map((i) => startOfDay(i.createdAt).getTime());
  const firstSaleAt = new Date(Math.min(...saleDates));
  const daysOfHistory = differenceInCalendarDays(startOfDay(now), firstSaleAt) + 1;

  // Never guess off 1-2 days of signal.
  const distinctSaleDays = new Set(saleDates).size;
  if (distinctSaleDays < MIN_SALE_DAYS_FOR_SIGNAL && daysOfHistory < MIN_SALE_DAYS_FOR_SIGNAL) {
    return { ticketTypeId: ticketType.id, name: ticketType.name, status: "INSUFFICIENT_DATA", predictedSoldOutDate: null, daysUntilEvent };
  }

  const window = Math.min(VELOCITY_WINDOW_CAP_DAYS, Math.max(1, daysOfHistory));
  const windowStart = new Date(now.getTime() - (window - 1) * 24 * 60 * 60 * 1000);
  const unitsInWindow = orderItems
    .filter((i) => startOfDay(i.createdAt).getTime() >= startOfDay(windowStart).getTime())
    .reduce((sum, i) => sum + i.quantity, 0);
  const velocityPerDay = unitsInWindow / window;

  if (velocityPerDay <= 0) {
    return { ticketTypeId: ticketType.id, name: ticketType.name, status: "SLOW", predictedSoldOutDate: null, daysUntilEvent };
  }

  const daysToSellOut = remaining / velocityPerDay;
  const predictedSoldOutDate = new Date(now.getTime() + daysToSellOut * 24 * 60 * 60 * 1000);

  const status: SellOutStatus = daysToSellOut < daysUntilEvent ? "LIKELY" : "ON_TRACK";
  return {
    ticketTypeId: ticketType.id,
    name: ticketType.name,
    status,
    predictedSoldOutDate: predictedSoldOutDate.toISOString(),
    daysUntilEvent,
  };
}

// ---------- revenue forecast ----------

export interface RevenueForecastPoint extends BarSeriesPoint {
  projected: boolean;
}

const MAX_PROJECTED_DAYS = 30;
const VELOCITY_TRAILING_DAYS = 7;

// Historical portion reuses bucketByDay's zero-filled day-series shape
// (from analytics.ts) over the FULL history since the first order (not the
// fixed 30-day TREND_WINDOW_DAYS window that page uses — an event can sell
// tickets over a much longer span). Projected portion linearly extrapolates
// the trailing-7-day average daily revenue forward, capped at
// MAX_PROJECTED_DAYS and never past eventStartsAt (revenue stops being
// meaningful once the event has happened).
export function forecastEventRevenue(
  orders: { createdAt: Date; totalCents: number }[],
  eventStartsAt: Date,
  now: Date = new Date(),
  formatValue: (cents: number) => string = (c) => String(c)
): RevenueForecastPoint[] {
  if (orders.length === 0) return [];

  const firstOrderAt = new Date(Math.min(...orders.map((o) => o.createdAt.getTime())));
  const historyDays = Math.max(1, differenceInCalendarDays(startOfDay(now), startOfDay(firstOrderAt)) + 1);
  const historical: DayPoint[] = bucketByDay(orders, (o) => o.createdAt, (o) => o.totalCents, historyDays);

  const points: RevenueForecastPoint[] = historical.map((p) => ({
    label: p.date,
    value: p.value,
    displayValue: formatValue(p.value),
    projected: false,
  }));

  if (startOfDay(now).getTime() >= startOfDay(eventStartsAt).getTime()) {
    return points; // event already happened (or is today) — nothing to project
  }

  const trailingWindow = Math.min(VELOCITY_TRAILING_DAYS, historyDays);
  const trailing = historical.slice(-trailingWindow);
  const avgDailyCents = trailing.reduce((sum, p) => sum + p.value, 0) / trailingWindow;

  const daysUntilEvent = differenceInCalendarDays(startOfDay(eventStartsAt), startOfDay(now));
  const projectedDays = Math.min(MAX_PROJECTED_DAYS, Math.max(0, daysUntilEvent));

  for (let i = 1; i <= projectedDays; i++) {
    const date = new Date(startOfDay(now).getTime() + i * 24 * 60 * 60 * 1000);
    const dateKey = date.toISOString().slice(0, 10);
    points.push({
      label: dateKey,
      value: Math.round(avgDailyCents),
      displayValue: formatValue(Math.round(avgDailyCents)),
      projected: true,
    });
  }

  return points;
}
