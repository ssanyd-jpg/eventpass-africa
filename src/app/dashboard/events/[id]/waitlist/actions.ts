"use server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { notifyNextInWaitlist } from "@/lib/waitlist";

// OWNER or STAFF, not GATE_CREW — same rule as the forecast/vendors pages
// and their data routes.
async function requireViewer() {
  const session = await auth();
  if (!session?.user?.id || session.user.organizationRole === "GATE_CREW") {
    throw new Error("Forbidden");
  }
  return session;
}

// Direct prisma.event.update(), bypassing the offline sync queue — same
// precedent as adminSetEventStatus (src/app/admin/events/actions.ts) writing
// straight to a Dexie-synced Event column. The next pull picks it up like
// any other Event change; no separate outbox entry is needed for a toggle
// this infrequent.
export async function setWaitlistEnabled(eventId: string, enabled: boolean) {
  const session = await requireViewer();
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { organizationId: true, title: true },
  });
  if (!event || event.organizationId !== session.user.organizationId) {
    throw new Error("Forbidden");
  }

  await prisma.event.update({ where: { id: eventId }, data: { waitlistEnabled: enabled } });

  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName: session.user.name ?? session.user.email ?? "Unknown",
    action: "EVENT_EDITED",
    summary: `${enabled ? "Enabled" : "Disabled"} the waitlist for "${event.title}"`,
  });
}

export async function notifyNextInWaitlistAction(eventId: string, ticketTypeId: string, count: number) {
  const session = await requireViewer();
  const ticketType = await prisma.ticketType.findUnique({
    where: { id: ticketTypeId },
    include: { event: { select: { id: true, organizationId: true, title: true } } },
  });
  if (!ticketType || ticketType.eventId !== eventId || ticketType.event.organizationId !== session.user.organizationId) {
    throw new Error("Forbidden");
  }

  const notified = await notifyNextInWaitlist(ticketTypeId, Math.max(1, Math.round(count)));

  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName: session.user.name ?? session.user.email ?? "Unknown",
    action: "WAITLIST_NOTIFIED",
    summary: `Notified ${notified.length} waitlist entr${notified.length === 1 ? "y" : "ies"} for "${ticketType.name}" at "${ticketType.event.title}"`,
  });

  return { notifiedCount: notified.length };
}
