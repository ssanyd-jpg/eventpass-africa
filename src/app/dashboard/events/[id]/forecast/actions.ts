"use server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { saveEventForecastCore, canAccessForecast } from "@/lib/revenue-forecast-data";

// OWNER or STAFF, not GATE_CREW — same rule as the forecast page and its
// data route.
async function requireViewer() {
  const session = await auth();
  if (!session?.user?.id || !canAccessForecast(session.user.organizationRole)) {
    throw new Error("Forbidden");
  }
  return session;
}

export async function saveEventForecast(input: {
  eventId: string;
  expectedAttendance: number;
  cashlessAdoptionRate: number; // 0..1
  avgSpendCents: number;
  durationDays: number;
}) {
  const session = await requireViewer();
  const actorName = session.user.name ?? session.user.email ?? "Unknown";

  const event = await prisma.event.findUnique({
    where: { id: input.eventId },
    select: { organizationId: true, title: true },
  });
  if (!event || event.organizationId !== session.user.organizationId) {
    throw new Error("Forbidden");
  }

  const expectedAttendance = Math.round(input.expectedAttendance);
  const avgSpendCents = Math.round(input.avgSpendCents);
  const durationDays = Math.round(input.durationDays);
  if (
    !Number.isFinite(input.cashlessAdoptionRate) ||
    input.cashlessAdoptionRate < 0 ||
    input.cashlessAdoptionRate > 1 ||
    expectedAttendance < 0 ||
    avgSpendCents < 0 ||
    durationDays < 1
  ) {
    throw new Error("Forecast inputs are out of range.");
  }

  await saveEventForecastCore({
    eventId: input.eventId,
    savedByUserId: session.user.id,
    expectedAttendance,
    cashlessAdoptionRate: input.cashlessAdoptionRate,
    avgSpendCents,
    durationDays,
  });

  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName,
    action: "FORECAST_SAVED",
    summary: `Saved a revenue forecast for "${event.title}"`,
  });
}
