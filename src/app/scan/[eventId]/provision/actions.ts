"use server";

import { auth } from "@/auth";
import { logAudit } from "@/lib/audit";
import { findAttendeeCandidates as findAttendeeCandidatesById, provisionWristband as provisionWristbandById } from "@/lib/wristband-handlers";

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

export async function findAttendeeCandidates(eventId: string, query: string) {
  const session = await requireViewer();
  return findAttendeeCandidatesById(session.user.organizationId, eventId, query);
}

export async function provisionWristband(
  eventId: string,
  nfcUid: string,
  attendee: { userId: string } | { email: string; name: string }
) {
  const session = await requireViewer();
  const actorName = session.user.name ?? session.user.email ?? "Unknown";
  const result = await provisionWristbandById(
    session.user.organizationId,
    eventId,
    nfcUid,
    session.user.id,
    actorName,
    attendee
  );
  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName,
    action: "CREDENTIAL_PROVISIONED",
    summary: `Provisioned a wristband for ${result.user.name} at "${result.eventTitle}"`,
  });
  return result;
}
