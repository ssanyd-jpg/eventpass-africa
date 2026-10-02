"use server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sendPendingGroupInvites, sendGroupArchiveMessage } from "@/lib/whatsapp-group";

// OWNER or STAFF, not GATE_CREW — same rule as resale/waitlist's own actions.
async function requireViewer() {
  const session = await auth();
  if (!session?.user?.id || session.user.organizationRole === "GATE_CREW") {
    throw new Error("Forbidden");
  }
  return session;
}

async function requireOwnedEvent(session: Awaited<ReturnType<typeof requireViewer>>, eventId: string) {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { organizationId: true, title: true },
  });
  if (!event || event.organizationId !== session.user.organizationId) {
    throw new Error("Forbidden");
  }
  return event;
}

// Direct prisma.event.update(), bypassing the offline sync queue — same
// precedent as setResaleSettings/setWaitlistEnabled. A link is only
// required to be a real WhatsApp invite link when the organiser is turning
// the feature on; disabling it (or leaving the link blank while enabled,
// to work on the group first) never blocks.
export async function setWhatsappGroupSettings(eventId: string, enabled: boolean, link: string | null) {
  const session = await requireViewer();
  const event = await requireOwnedEvent(session, eventId);

  const trimmedLink = link?.trim() || null;
  if (trimmedLink && !trimmedLink.startsWith("https://chat.whatsapp.com/")) {
    throw new Error("Paste a WhatsApp group invite link (starts with https://chat.whatsapp.com/).");
  }

  await prisma.event.update({
    where: { id: eventId },
    data: { whatsappGroupEnabled: enabled, whatsappGroupLink: trimmedLink },
  });

  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName: session.user.name ?? session.user.email ?? "Unknown",
    action: "EVENT_EDITED",
    summary: `${enabled ? "Enabled" : "Disabled"} the WhatsApp group for "${event.title}"`,
  });
}

export async function sendGroupInvitesNow(eventId: string) {
  const session = await requireViewer();
  const event = await requireOwnedEvent(session, eventId);

  const { sentCount } = await sendPendingGroupInvites(eventId);

  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName: session.user.name ?? session.user.email ?? "Unknown",
    action: "WHATSAPP_GROUP_INVITE_SENT",
    summary: `Sent ${sentCount} WhatsApp group invite${sentCount === 1 ? "" : "s"} for "${event.title}"`,
  });

  return { sentCount };
}

export async function sendGroupArchiveMessageNow(eventId: string) {
  const session = await requireViewer();
  const event = await requireOwnedEvent(session, eventId);

  const result = await sendGroupArchiveMessage(eventId);
  if (!result.sent) {
    throw new Error("This event's WhatsApp group has already been archived, or the event hasn't ended yet.");
  }

  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName: session.user.name ?? session.user.email ?? "Unknown",
    action: "WHATSAPP_GROUP_ARCHIVED",
    summary: `Archived the WhatsApp group for "${event.title}" (${result.notifiedCount} attendee${result.notifiedCount === 1 ? "" : "s"} notified)`,
  });

  return result;
}

// Dismisses the dashboard's "revoke your invite link" reminder banner —
// doesn't touch whatsappGroupLink itself, see its own doc comment.
export async function markWhatsappGroupLinkRevoked(eventId: string) {
  const session = await requireViewer();
  await requireOwnedEvent(session, eventId);
  await prisma.event.update({ where: { id: eventId }, data: { whatsappGroupLinkRevokedAt: new Date() } });
}
