"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { logAudit } from "@/lib/audit";
import {
  createFeaturedListing,
  createBroadcast,
  sendBroadcast,
  estimateBroadcastReach,
  type FeaturedTier,
} from "@/lib/chaap-ads";

// OWNER or STAFF, not GATE_CREW — same rule as loyalty/season-passes'
// dashboard actions.
async function requireViewer() {
  const session = await auth();
  if (!session?.user?.id || session.user.organizationRole === "GATE_CREW") {
    throw new Error("Forbidden");
  }
  return session;
}

export async function estimateReachAction(targetEventTypes: string[]) {
  await requireViewer();
  return estimateBroadcastReach(targetEventTypes);
}

export async function promoteEventAction(
  eventId: string,
  tier: FeaturedTier,
  eventTitle: string,
  payer: { phoneNumber: string; mobileNetwork?: string }
) {
  const session = await requireViewer();
  const result = await createFeaturedListing(eventId, tier, session.user.organizationId, payer);
  if (!result.ok || result.status !== "CONFIRMED") return result;

  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName: session.user.name ?? session.user.email ?? "Unknown",
    action: "FEATURED_LISTING_PURCHASED",
    summary: `Bought a ${tier} listing for "${eventTitle}"`,
  });

  revalidatePath("/dashboard/ads");
  revalidatePath("/events");
  return result;
}

export async function createBroadcastAction(
  message: string,
  targetEventTypes: string[],
  sendNow: boolean,
  scheduledAt: Date,
  payer: { phoneNumber: string; mobileNetwork?: string }
) {
  const session = await requireViewer();
  const result = await createBroadcast(session.user.organizationId, message, targetEventTypes, scheduledAt, payer);
  if (!result.ok || result.status !== "CONFIRMED") return result;

  let sendResult: { recipientCount: number } | null = null;
  if (sendNow) {
    const sent = await sendBroadcast(result.broadcastId);
    if (sent.ok) {
      sendResult = sent.result;
      await logAudit({
        organizationId: session.user.organizationId,
        actorUserId: session.user.id,
        actorName: session.user.name ?? session.user.email ?? "Unknown",
        action: "AD_BROADCAST_SENT",
        summary: `Sent a WhatsApp broadcast to ${sent.result.recipientCount} attendee${sent.result.recipientCount === 1 ? "" : "s"}`,
      });
    }
  }

  revalidatePath("/dashboard/ads");
  return { ...result, sentNow: sendResult !== null, recipientCount: sendResult?.recipientCount ?? null };
}

export async function sendScheduledBroadcastAction(broadcastId: string) {
  const session = await requireViewer();
  const result = await sendBroadcast(broadcastId);
  if (!result.ok) return result;

  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName: session.user.name ?? session.user.email ?? "Unknown",
    action: "AD_BROADCAST_SENT",
    summary: `Sent a scheduled WhatsApp broadcast to ${result.result.recipientCount} attendee${result.result.recipientCount === 1 ? "" : "s"}`,
  });

  revalidatePath("/dashboard/ads");
  return result;
}
