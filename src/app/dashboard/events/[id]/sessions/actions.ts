"use server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";

// OWNER or STAFF, not GATE_CREW — session setup is a desk job, same rule as
// saveTimingPoints in the sibling MARATHON feature.
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

export interface ConferenceSessionInput {
  clientId: string;
  name: string;
  speaker: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
}

// Whole-list save, not per-session ops — same "one editing session, rarely
// changes after" reasoning saveTimingPoints itself documents. Upserts every
// session by clientId and deletes any existing session whose clientId isn't
// in the new list.
export async function saveConferenceSessions(eventId: string, sessions: ConferenceSessionInput[]) {
  const session = await requireViewer();
  const actorName = session.user.name ?? session.user.email ?? "Unknown";
  const event = await getOwnedEvent(session.user.organizationId, eventId);

  const existing = await prisma.conferenceSession.findMany({ where: { eventId }, select: { id: true, clientId: true } });
  const keep = new Set(sessions.map((s) => s.clientId));
  const toDelete = existing.filter((e) => e.clientId && !keep.has(e.clientId));

  await prisma.$transaction([
    ...toDelete.map((e) => prisma.conferenceSession.delete({ where: { id: e.id } })),
    ...sessions.map((s) =>
      prisma.conferenceSession.upsert({
        where: { clientId: s.clientId },
        create: {
          clientId: s.clientId,
          eventId,
          name: s.name.trim(),
          speaker: s.speaker?.trim() || null,
          location: s.location?.trim() || null,
          startsAt: new Date(s.startsAt),
          endsAt: new Date(s.endsAt),
        },
        update: {
          name: s.name.trim(),
          speaker: s.speaker?.trim() || null,
          location: s.location?.trim() || null,
          startsAt: new Date(s.startsAt),
          endsAt: new Date(s.endsAt),
        },
      })
    ),
  ]);

  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName,
    action: "CONFERENCE_SESSIONS_SAVED",
    summary: `Saved ${sessions.length} conference session(s) for "${event.title}"`,
  });

  return prisma.conferenceSession.findMany({ where: { eventId }, orderBy: { startsAt: "asc" } });
}
