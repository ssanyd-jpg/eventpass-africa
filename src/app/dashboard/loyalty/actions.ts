"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { logAudit } from "@/lib/audit";
import { createReward, toggleReward, type CreateRewardInput } from "@/lib/loyalty-rewards";

// OWNER or STAFF, not GATE_CREW — same rule as the resale/waitlist settings
// actions.
async function requireViewer() {
  const session = await auth();
  if (!session?.user?.id || session.user.organizationRole === "GATE_CREW") {
    throw new Error("Forbidden");
  }
  return session;
}

export async function createRewardAction(input: CreateRewardInput) {
  const session = await requireViewer();
  const result = await createReward(session.user.organizationId, input);
  if (!result.ok) return result;

  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName: session.user.name ?? session.user.email ?? "Unknown",
    action: "LOYALTY_REWARD_CREATED",
    summary: `Created loyalty reward "${input.name}"`,
  });

  revalidatePath("/dashboard/loyalty");
  return result;
}

export async function toggleRewardAction(rewardId: string, active: boolean, rewardName: string) {
  const session = await requireViewer();
  const result = await toggleReward(session.user.organizationId, rewardId, active);
  if (!result.ok) return result;

  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName: session.user.name ?? session.user.email ?? "Unknown",
    action: "LOYALTY_REWARD_STATUS_CHANGED",
    summary: `${active ? "Activated" : "Deactivated"} loyalty reward "${rewardName}"`,
  });

  revalidatePath("/dashboard/loyalty");
  return result;
}
