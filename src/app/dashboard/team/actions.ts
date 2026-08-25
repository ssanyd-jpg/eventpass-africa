"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { defaultOrganizationName } from "@/lib/organizations";

// Removing a member doesn't delete their membership row — per this
// codebase's "every user has exactly one organization, always" invariant,
// they instead land on a fresh personal organization of their own, keeping
// their account intact while losing access to the team's events.
export async function removeMember(userId: string) {
  const session = await auth();
  if (!session?.user?.id || session.user.organizationRole !== "OWNER") {
    throw new Error("Forbidden");
  }
  if (userId === session.user.id) {
    throw new Error("You can't remove yourself.");
  }

  const membership = await prisma.organizationMembership.findUnique({
    where: { userId },
    include: { user: { select: { name: true } } },
  });
  if (!membership || membership.organizationId !== session.user.organizationId) {
    throw new Error("Not a member of your organization.");
  }

  // Not createPersonalOrganization() — this user already has a membership
  // row (unique on userId), so it needs updating in place, not creating.
  await prisma.$transaction(async (tx) => {
    const freshOrg = await tx.organization.create({
      data: { name: defaultOrganizationName(membership.user.name) },
    });
    await tx.organizationMembership.update({
      where: { userId },
      data: { organizationId: freshOrg.id, role: "OWNER" },
    });
  });

  revalidatePath("/dashboard/team");
}
