import { prisma } from "@/lib/prisma";
import {
  summarizeHistoricalPerformance,
  type HistoricalSummary,
  type PastEventPerformance,
  type TicketTier,
} from "@/lib/revenue-forecast";

// DB layer for the forecast page, split from the route/action so it's
// directly testable without auth() — same split as
// vendor-dashboard-data.ts / reconciliation.ts in the prior sessions.

// The forecast page, its data route, and its save action are all open to
// any org member except GATE_CREW (event-day door staff — no planning
// role). Pulled into a named function so the "GATE_CREW blocked" rule is
// one testable thing, not three inline string comparisons.
export function canAccessForecast(organizationRole: string | undefined): boolean {
  return organizationRole !== "GATE_CREW";
}

export interface ForecastPageData {
  eventId: string;
  eventTitle: string;
  currency: string;
  ticketTiers: (TicketTier & { name: string })[];
  defaultExpectedAttendance: number;
  savedForecast: {
    expectedAttendance: number;
    cashlessAdoptionRate: number;
    avgSpendCents: number;
    durationDays: number;
    savedAt: string;
  } | null;
  historical: HistoricalSummary;
}

export async function getForecastPageData(eventId: string, now: Date = new Date()): Promise<ForecastPageData | null> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      title: true,
      currency: true,
      organizationId: true,
      ticketTypes: { select: { name: true, priceCents: true, quantityTotal: true } },
      forecast: {
        select: {
          expectedAttendance: true,
          cashlessAdoptionRate: true,
          avgSpendCents: true,
          durationDays: true,
          savedAt: true,
        },
      },
    },
  });
  if (!event) return null;

  const ticketTiers = event.ticketTypes.map((t) => ({
    name: t.name,
    priceCents: t.priceCents,
    quantityTotal: t.quantityTotal,
  }));

  // The organiser's other events that have already started — the pool the
  // "what actually happened last time" comparison draws on.
  const pastEvents = await prisma.event.findMany({
    where: {
      organizationId: event.organizationId,
      id: { not: eventId },
      status: { not: "CANCELLED" },
      startsAt: { lt: now },
    },
    select: { id: true },
  });

  const perf: PastEventPerformance[] = await Promise.all(
    pastEvents.map(async (pe) => {
      const [ticketHolders, walletCount, topUp] = await Promise.all([
        prisma.ticket.count({ where: { eventId: pe.id, order: { status: { in: ["PAID", "NEEDS_REVIEW"] } } } }),
        prisma.wallet.count({ where: { eventId: pe.id } }),
        prisma.walletTransaction.aggregate({
          where: { wallet: { eventId: pe.id }, type: "TOPUP", status: "COMPLETED" },
          _sum: { amountCents: true },
        }),
      ]);
      return { ticketHolders, walletCount, topUpVolumeCents: topUp._sum.amountCents ?? 0 };
    })
  );

  return {
    eventId: event.id,
    eventTitle: event.title,
    currency: event.currency,
    ticketTiers,
    defaultExpectedAttendance: ticketTiers.reduce((sum, t) => sum + t.quantityTotal, 0),
    savedForecast: event.forecast
      ? {
          expectedAttendance: event.forecast.expectedAttendance,
          cashlessAdoptionRate: event.forecast.cashlessAdoptionRate,
          avgSpendCents: event.forecast.avgSpendCents,
          durationDays: event.forecast.durationDays,
          savedAt: event.forecast.savedAt.toISOString(),
        }
      : null,
    historical: summarizeHistoricalPerformance(perf),
  };
}

// Idempotent upsert keyed on the unique eventId — "Save forecast" replaces
// the single saved forecast for this event.
export async function saveEventForecastCore(params: {
  eventId: string;
  savedByUserId: string;
  expectedAttendance: number;
  cashlessAdoptionRate: number;
  avgSpendCents: number;
  durationDays: number;
}) {
  return prisma.eventForecast.upsert({
    where: { eventId: params.eventId },
    create: {
      eventId: params.eventId,
      savedByUserId: params.savedByUserId,
      expectedAttendance: params.expectedAttendance,
      cashlessAdoptionRate: params.cashlessAdoptionRate,
      avgSpendCents: params.avgSpendCents,
      durationDays: params.durationDays,
      savedAt: new Date(),
    },
    update: {
      savedByUserId: params.savedByUserId,
      expectedAttendance: params.expectedAttendance,
      cashlessAdoptionRate: params.cashlessAdoptionRate,
      avgSpendCents: params.avgSpendCents,
      durationDays: params.durationDays,
      savedAt: new Date(),
    },
  });
}
