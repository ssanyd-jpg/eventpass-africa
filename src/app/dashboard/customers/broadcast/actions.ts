"use server";

import { auth } from "@/auth";
import { logAudit } from "@/lib/audit";
import { resolveBroadcastAudience, sendBroadcast } from "@/lib/crm-handlers";

// OWNER-only — consequential, spam-risk action, matches settlements/run,
// organization/invite, and device revoke.
async function requireOwner() {
  const session = await auth();
  if (!session?.user?.id || session.user.organizationRole !== "OWNER") {
    throw new Error("Forbidden");
  }
  return session;
}

export async function previewAudience(eventId: string, ticketTypeId: string | null) {
  const session = await requireOwner();
  const { recipients } = await resolveBroadcastAudience(session.user.organizationId, eventId, ticketTypeId);
  return recipients.length;
}

export async function sendBroadcastAction(eventId: string, ticketTypeId: string | null, subject: string, body: string) {
  const session = await requireOwner();
  const result = await sendBroadcast(
    session.user.organizationId,
    eventId,
    ticketTypeId,
    subject,
    body,
    session.user.id,
    session.user.name ?? session.user.email ?? "Unknown"
  );
  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName: session.user.name ?? session.user.email ?? "Unknown",
    action: "BROADCAST_SENT",
    summary: `Sent broadcast "${subject}" to ${result.recipientCount} customer${result.recipientCount === 1 ? "" : "s"} for "${result.eventTitle}"`,
  });
  return result;
}
