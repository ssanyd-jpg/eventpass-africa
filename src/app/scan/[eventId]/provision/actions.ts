"use server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { findAttendeeCandidates as findAttendeeCandidatesById } from "@/lib/wristband-handlers";
import { checkInVolunteer } from "@/lib/volunteers";
import { logAudit } from "@/lib/audit";

// OWNER or STAFF, not GATE_CREW — matches credential-handlers.ts's own
// requireViewer() precedent for this exact model (any staff member can
// provision, not just the org owner).
async function requireViewer() {
  const session = await auth();
  if (!session?.user?.id || session.user.organizationRole === "GATE_CREW") {
    throw new Error("Forbidden");
  }
  return session;
}

// Provisioning itself is now the PROVISION_CREDENTIAL outbox op (see
// src/lib/sync-handlers.ts's handleProvisionCredential) so it works
// offline — only the online attendee search stays a Server Action here.
export async function findAttendeeCandidates(eventId: string, query: string) {
  const session = await requireViewer();
  return findAttendeeCandidatesById(session.user.organizationId, eventId, query);
}

// Session 30 — a volunteer's wristband is provisioned by phone lookup
// rather than the attendee name/email/ticket search above, and kept
// online-only (a direct Server Action, not a queueOp outbox entry): the
// volunteer desk has connectivity, unlike the gate scanner's own offline
// requirement.
export async function checkInVolunteerAction(eventId: string, phone: string, nfcUid: string) {
  const session = await requireViewer();
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { organizationId: true, title: true } });
  if (!event || event.organizationId !== session.user.organizationId) {
    throw new Error("Forbidden");
  }

  const result = await checkInVolunteer({
    eventId,
    phone,
    nfcUid,
    organizationId: session.user.organizationId,
    createdByUserId: session.user.id,
    createdByName: session.user.name ?? session.user.email ?? "Unknown",
  });
  if (!result) return null;

  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName: session.user.name ?? session.user.email ?? "Unknown",
    action: "VOLUNTEER_CHECKED_IN",
    summary: `Checked in volunteer "${result.volunteer.name}" (${result.volunteer.role}) for "${event.title}"`,
  });

  return {
    name: result.volunteer.name,
    role: result.volunteer.role,
    shiftStart: result.volunteer.shiftStart.toISOString(),
    shiftEnd: result.volunteer.shiftEnd.toISOString(),
    zoneAccess: result.volunteer.zoneAccess,
  };
}
