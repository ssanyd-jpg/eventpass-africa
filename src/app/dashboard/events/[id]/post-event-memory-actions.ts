"use server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { runPostEventMemorySweep } from "@/lib/post-event-memory-data";

// OWNER or STAFF, not GATE_CREW — same rule as every other dashboard
// Server Action (see waitlist/actions.ts).
async function requireViewer() {
  const session = await auth();
  if (!session?.user?.id || session.user.organizationRole === "GATE_CREW") {
    throw new Error("Forbidden");
  }
  return session;
}

export async function sendPostEventMemories(eventId: string) {
  const session = await requireViewer();
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { organizationId: true, title: true },
  });
  if (!event || event.organizationId !== session.user.organizationId) {
    throw new Error("Forbidden");
  }

  const result = await runPostEventMemorySweep(eventId);

  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName: session.user.name ?? session.user.email ?? "Unknown",
    action: "POST_EVENT_MEMORY",
    summary: `Sent post-event memories to ${result.notifiedCount} attendee${result.notifiedCount === 1 ? "" : "s"} for "${event.title}"`,
  });

  return { notifiedCount: result.notifiedCount };
}
