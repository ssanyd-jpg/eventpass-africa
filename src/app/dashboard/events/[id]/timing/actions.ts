"use server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";

// OWNER or STAFF, not GATE_CREW — race setup is a desk job before race day,
// same rule as every other event-configuration action in this app.
async function requireViewer() {
  const session = await auth();
  if (!session?.user?.id || session.user.organizationRole === "GATE_CREW") {
    throw new Error("Forbidden");
  }
  return session;
}

async function getOwnedEvent(organizationId: string, eventId: string) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event || event.organizationId !== organizationId) {
    throw new Error("Forbidden");
  }
  return event;
}

export interface TimingPointInput {
  clientId: string;
  name: string;
  location: string;
  sequenceOrder: number;
  isStart: boolean;
  isFinish: boolean;
  distanceMeters: number | null;
}

// Whole-list save, not per-point ops — race setup happens as one editing
// session (add a few points, reorder, save), and a course rarely changes
// after that. Upserts every point by clientId and deletes any existing
// point whose clientId isn't in the new list (removed in the editor).
export async function saveTimingPoints(eventId: string, points: TimingPointInput[]) {
  const session = await requireViewer();
  const actorName = session.user.name ?? session.user.email ?? "Unknown";
  const event = await getOwnedEvent(session.user.organizationId, eventId);

  const existing = await prisma.timingPoint.findMany({ where: { eventId }, select: { id: true, clientId: true } });
  const keep = new Set(points.map((p) => p.clientId));
  const toDelete = existing.filter((e) => e.clientId && !keep.has(e.clientId));

  await prisma.$transaction([
    ...toDelete.map((e) => prisma.timingPoint.delete({ where: { id: e.id } })),
    ...points.map((p) =>
      prisma.timingPoint.upsert({
        where: { clientId: p.clientId },
        create: {
          clientId: p.clientId,
          eventId,
          name: p.name.trim(),
          location: p.location.trim(),
          sequenceOrder: p.sequenceOrder,
          isStart: p.isStart,
          isFinish: p.isFinish,
          distanceMeters: p.distanceMeters,
        },
        update: {
          name: p.name.trim(),
          location: p.location.trim(),
          sequenceOrder: p.sequenceOrder,
          isStart: p.isStart,
          isFinish: p.isFinish,
          distanceMeters: p.distanceMeters,
        },
      })
    ),
  ]);

  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName,
    action: "TIMING_POINTS_SAVED",
    summary: `Saved ${points.length} timing point(s) for "${event.title}"`,
  });

  return prisma.timingPoint.findMany({ where: { eventId }, orderBy: { sequenceOrder: "asc" } });
}

// Sets Event.gunStartAt = now(). Irreversible by design (see the schema
// comment on Event.gunStartAt) — every ChipTime's gunTimeOffsetSeconds
// anchors on this moment, so changing it after taps exist would silently
// rewrite every athlete's recorded time.
export async function startGun(eventId: string) {
  const session = await requireViewer();
  const actorName = session.user.name ?? session.user.email ?? "Unknown";
  const event = await getOwnedEvent(session.user.organizationId, eventId);

  if (event.gunStartAt) {
    throw new Error("The gun has already been started for this event.");
  }

  const updated = await prisma.event.update({ where: { id: eventId }, data: { gunStartAt: new Date() } });

  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName,
    action: "GUN_STARTED",
    summary: `Started the gun for "${event.title}"`,
  });

  return updated.gunStartAt!.toISOString();
}
