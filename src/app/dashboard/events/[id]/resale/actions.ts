"use server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";

// OWNER or STAFF, not GATE_CREW — same rule as the waitlist actions.
async function requireViewer() {
  const session = await auth();
  if (!session?.user?.id || session.user.organizationRole === "GATE_CREW") {
    throw new Error("Forbidden");
  }
  return session;
}

// Direct prisma.event.update(), bypassing the offline sync queue — same
// precedent as setWaitlistEnabled. maxResalePrice is minor units; null clears
// it, leaving each ticket's face value as the only ceiling. Resale can never
// be priced above face value whatever this is set to (see validateAskingPrice
// in src/lib/resale.ts) — this can only lower the ceiling further.
export async function setResaleSettings(eventId: string, enabled: boolean, maxResalePrice: number | null) {
  const session = await requireViewer();
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { organizationId: true, title: true },
  });
  if (!event || event.organizationId !== session.user.organizationId) {
    throw new Error("Forbidden");
  }
  if (maxResalePrice !== null && (!Number.isInteger(maxResalePrice) || maxResalePrice <= 0)) {
    throw new Error("The maximum resale price must be a positive amount.");
  }

  await prisma.event.update({ where: { id: eventId }, data: { resaleEnabled: enabled, maxResalePrice } });

  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName: session.user.name ?? session.user.email ?? "Unknown",
    action: "EVENT_EDITED",
    summary: `${enabled ? "Enabled" : "Disabled"} ticket resale for "${event.title}"${enabled && maxResalePrice !== null ? " with a maximum resale price" : ""}`,
  });
}
