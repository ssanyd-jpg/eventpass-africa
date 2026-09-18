import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { checkInsByHour, transactionsByVendorByHour, liveEventStats } from "@/lib/analytics";
import { getLiveEventData } from "@/lib/analytics-data";
import { getLiveActivityFeed } from "@/lib/live-activity";
import { runDensityMonitoring } from "@/lib/crowd-density";
import { logIfSlow } from "@/lib/perf-log";

// Polled by the live-event dashboard page every 30s — deliberately a plain
// GET an authenticated client can re-fetch on an interval, not a one-shot
// server-component load, since the whole point of this view is watching
// numbers change during the event rather than a static snapshot. Timed
// end-to-end (Session 22) since a 30s poll that itself takes seconds
// defeats the point of "live".
export async function GET(request: Request, { params }: { params: { id: string } }) {
  const startedAt = Date.now();
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, reason: "UNAUTHENTICATED" }, { status: 401 });
  }
  // Mirrors the analytics dashboard's own access rule: block GATE_CREW only,
  // same reasoning as src/app/api/dashboard/analytics/export/route.ts.
  if (session.user.organizationRole === "GATE_CREW") {
    return NextResponse.json({ ok: false, reason: "FORBIDDEN" }, { status: 403 });
  }

  const event = await prisma.event.findUnique({
    where: { id: params.id },
    select: { organizationId: true, title: true, currency: true },
  });
  if (!event || event.organizationId !== session.user.organizationId) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  const data = await getLiveEventData(params.id);
  if (!data.event) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  const now = new Date();
  const stats = liveEventStats(data.tickets, data.ticketTypes, data.wallets, data.walletTxs, now);
  const checkIns = checkInsByHour(data.tickets, data.event.startsAt, now);
  const vendorHourly = transactionsByVendorByHour(data.walletTxs, data.event.startsAt, now);
  const activity = await getLiveActivityFeed(params.id);
  // Session 29 — recomputes zone density and (best-effort) fires any new
  // safety alerts on every poll of this same 30s-interval route, per the
  // spec's "no new polling mechanism needed."
  const density = await runDensityMonitoring(params.id);
  const [unresolvedAlerts, resolvedAlerts] = await Promise.all([
    prisma.densityAlert.findMany({
      where: { eventId: params.id, resolvedAt: null },
      orderBy: { triggeredAt: "desc" },
    }),
    prisma.densityAlert.findMany({
      where: { eventId: params.id, resolvedAt: { not: null } },
      orderBy: { resolvedAt: "desc" },
      take: 20,
    }),
  ]);

  logIfSlow(`GET /api/dashboard/events/${params.id}/live`, startedAt);

  return NextResponse.json({
    ok: true,
    eventTitle: event.title,
    currency: event.currency,
    stats: { ...stats, lastUpdated: stats.lastUpdated.toISOString() },
    checkIns,
    vendorHourly,
    activity: activity.map((a) => ({ ...a, at: a.at.toISOString() })),
    zoneDensity: density.zones,
    unresolvedAlerts: unresolvedAlerts.map((a) => ({
      id: a.id,
      zoneName: a.zoneName,
      alertType: a.alertType,
      triggeredAt: a.triggeredAt.toISOString(),
      message: a.message,
    })),
    resolvedAlerts: resolvedAlerts.map((a) => ({
      id: a.id,
      zoneName: a.zoneName,
      alertType: a.alertType,
      triggeredAt: a.triggeredAt.toISOString(),
      resolvedAt: a.resolvedAt!.toISOString(),
      resolvedBy: a.resolvedBy,
      resolutionNote: a.resolutionNote,
      message: a.message,
    })),
  });
}
