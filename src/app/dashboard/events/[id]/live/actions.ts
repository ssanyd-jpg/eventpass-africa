"use server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { resolveDensityAlert } from "@/lib/crowd-density";

// Same access rule as every other event-configuration/organiser action in
// this app (see timing/actions.ts's requireViewer) — GATE_CREW never
// reaches this page at all (middleware + the page's own client-side
// redirect), but the action itself still enforces it independently.
async function requireViewer() {
  const session = await auth();
  if (!session?.user?.id || session.user.organizationRole === "GATE_CREW") {
    throw new Error("Forbidden");
  }
  return session;
}

// Session 29 — organiser marks a density alert resolved with a free-text
// note (e.g. "Additional barriers added", "Redirected crowd to Zone B").
// Scoped by eventId + the caller's organizationId, same double-check shape
// as getOwnedEvent in timing/actions.ts, so one organisation can never
// resolve another's alert even with a guessed alertId.
export async function resolveDensityAlertAction(eventId: string, alertId: string, note: string) {
  const session = await requireViewer();
  const actorName = session.user.name ?? session.user.email ?? "Unknown";

  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true, title: true, organizationId: true } });
  if (!event || event.organizationId !== session.user.organizationId) {
    throw new Error("Forbidden");
  }

  const alert = await prisma.densityAlert.findUnique({ where: { id: alertId } });
  if (!alert || alert.eventId !== eventId) {
    throw new Error("Alert not found");
  }
  if (alert.resolvedAt) {
    return alert;
  }

  const resolved = await resolveDensityAlert(alertId, actorName, note);

  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName,
    action: "DENSITY_ALERT_RESOLVED",
    summary: `Resolved a ${alert.alertType} density alert for "${alert.zoneName}" at "${event.title}"`,
  });

  return resolved;
}
