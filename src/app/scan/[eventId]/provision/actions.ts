"use server";

import { auth } from "@/auth";
import { findAttendeeCandidates as findAttendeeCandidatesById } from "@/lib/wristband-handlers";

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
