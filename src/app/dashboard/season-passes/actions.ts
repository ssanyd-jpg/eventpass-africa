"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { logAudit } from "@/lib/audit";
import {
  createSeasonPass,
  publishSeasonPass,
  linkEventToSeasonPass,
  setAutoRenewSettings,
  provisionSeasonPassWristband,
  type CreateSeasonPassInput,
} from "@/lib/season-pass";
import { sendRenewalOffer, getSeasonPassesEligibleForRenewal } from "@/lib/season-renewal";

// OWNER or STAFF, not GATE_CREW — same rule as the loyalty rewards actions.
async function requireViewer() {
  const session = await auth();
  if (!session?.user?.id || session.user.organizationRole === "GATE_CREW") {
    throw new Error("Forbidden");
  }
  return session;
}

export async function createSeasonPassAction(input: CreateSeasonPassInput) {
  const session = await requireViewer();
  const result = await createSeasonPass(session.user.organizationId, input);
  if (!result.ok) return result;

  revalidatePath("/dashboard/season-passes");
  return result;
}

export async function publishSeasonPassAction(seasonPassId: string) {
  const session = await requireViewer();
  const result = await publishSeasonPass(session.user.organizationId, seasonPassId);
  if (!result.ok) return result;

  revalidatePath("/dashboard/season-passes");
  revalidatePath(`/dashboard/season-passes/${seasonPassId}`);
  return result;
}

export async function linkEventAction(seasonPassId: string, eventId: string) {
  const session = await requireViewer();
  const result = await linkEventToSeasonPass(session.user.organizationId, seasonPassId, eventId);
  if (!result.ok) return result;

  revalidatePath(`/dashboard/season-passes/${seasonPassId}`);
  return result;
}

export async function setAutoRenewAction(seasonPassId: string, autoRenewEnabled: boolean, autoRenewPrice: number | null) {
  const session = await requireViewer();
  const result = await setAutoRenewSettings(session.user.organizationId, seasonPassId, { autoRenewEnabled, autoRenewPrice });
  if (!result.ok) return result;

  revalidatePath("/dashboard/season-passes");
  revalidatePath(`/dashboard/season-passes/${seasonPassId}`);
  return result;
}

export async function provisionWristbandAction(holderId: string, nfcUid: string) {
  const session = await requireViewer();
  const result = await provisionSeasonPassWristband(session.user.organizationId, holderId, nfcUid, {
    userId: session.user.id,
    name: session.user.name ?? session.user.email ?? "Unknown",
  });
  if (!result.ok) return result;

  revalidatePath("/dashboard/season-passes");
  return result;
}

// The manual "Send renewal offers now" trigger — organiser-initiated, so
// (unlike the cron sweep, which has no real actorUserId to attribute a log
// entry to) this is the one place SEASON_PASS_RENEWAL_OFFERED gets an audit
// entry, a summary count rather than one row per holder.
export async function sendRenewalOffersNowAction(seasonPassId: string) {
  const session = await requireViewer();
  const eligible = (await getSeasonPassesEligibleForRenewal()).filter((h) => h.seasonPassId === seasonPassId);

  let sent = 0;
  for (const holder of eligible) {
    const result = await sendRenewalOffer(holder.holderId);
    if (result.ok && !("skipped" in result)) sent++;
  }

  if (sent > 0) {
    await logAudit({
      organizationId: session.user.organizationId,
      actorUserId: session.user.id,
      actorName: session.user.name ?? session.user.email ?? "Unknown",
      action: "SEASON_PASS_RENEWAL_OFFERED",
      summary: `Sent ${sent} season pass renewal offer${sent === 1 ? "" : "s"}`,
    });
  }

  revalidatePath("/dashboard/season-passes");
  revalidatePath(`/dashboard/season-passes/${seasonPassId}`);
  return { ok: true as const, sent, checked: eligible.length };
}
