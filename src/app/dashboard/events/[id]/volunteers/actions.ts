"use server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import {
  createVolunteer,
  bulkImportVolunteers,
  sendVolunteerInvite,
  setVolunteerStatus,
  type VolunteerStatus,
} from "@/lib/volunteers";

// OWNER or STAFF, not GATE_CREW — same rule as every other event-
// configuration action (see timing/actions.ts).
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

export interface AddVolunteerInput {
  name: string;
  phone: string;
  email?: string;
  role: string;
  shiftStart: string; // ISO, from a <input type="datetime-local">
  shiftEnd: string;
  zoneAccess: string[];
  notes?: string;
}

export async function addVolunteerAction(eventId: string, input: AddVolunteerInput) {
  const session = await requireViewer();
  const event = await getOwnedEvent(session.user.organizationId, eventId);

  const volunteer = await createVolunteer({
    eventId,
    name: input.name,
    phone: input.phone,
    email: input.email,
    role: input.role,
    shiftStart: new Date(input.shiftStart),
    shiftEnd: new Date(input.shiftEnd),
    zoneAccess: input.zoneAccess,
    notes: input.notes,
  });

  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName: session.user.name ?? session.user.email ?? "Unknown",
    action: "VOLUNTEER_ADDED",
    summary: `Added volunteer "${volunteer.name}" (${volunteer.role}) for "${event.title}"`,
  });

  return volunteer;
}

export async function importVolunteersAction(eventId: string, csvText: string) {
  const session = await requireViewer();
  const event = await getOwnedEvent(session.user.organizationId, eventId);

  const result = await bulkImportVolunteers(eventId, csvText);

  if (result.created > 0) {
    await logAudit({
      organizationId: session.user.organizationId,
      actorUserId: session.user.id,
      actorName: session.user.name ?? session.user.email ?? "Unknown",
      action: "VOLUNTEERS_IMPORTED",
      summary: `Imported ${result.created} volunteer(s) for "${event.title}"${result.errors.length > 0 ? ` (${result.errors.length} row(s) skipped)` : ""}`,
    });
  }

  return result;
}

export async function sendVolunteerInviteAction(eventId: string, volunteerId: string) {
  const session = await requireViewer();
  const event = await getOwnedEvent(session.user.organizationId, eventId);

  const volunteer = await prisma.volunteer.findUnique({ where: { id: volunteerId } });
  if (!volunteer || volunteer.eventId !== eventId) {
    throw new Error("Forbidden");
  }

  const updated = await sendVolunteerInvite(volunteerId);

  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName: session.user.name ?? session.user.email ?? "Unknown",
    action: "VOLUNTEER_INVITED",
    summary: `Sent a volunteer invitation to "${volunteer.name}" for "${event.title}"`,
  });

  return updated;
}

export async function setVolunteerStatusAction(eventId: string, volunteerId: string, status: VolunteerStatus) {
  const session = await requireViewer();
  const event = await getOwnedEvent(session.user.organizationId, eventId);

  const volunteer = await prisma.volunteer.findUnique({ where: { id: volunteerId } });
  if (!volunteer || volunteer.eventId !== eventId) {
    throw new Error("Forbidden");
  }

  const updated = await setVolunteerStatus(volunteerId, status);

  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName: session.user.name ?? session.user.email ?? "Unknown",
    action: "VOLUNTEER_STATUS_UPDATED",
    summary: `Marked "${volunteer.name}" as ${status} for "${event.title}"`,
  });

  return updated;
}
