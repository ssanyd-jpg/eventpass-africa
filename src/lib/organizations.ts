import type { Prisma } from "@prisma/client";

export function defaultOrganizationName(userName: string) {
  return `${userName}'s Organization`;
}

// Every user belongs to exactly one organization, always — see the comment
// on the Organization model in prisma/schema.prisma. Called at registration,
// by the backfill migration script, and when removing a team member (they
// keep their account but land on a fresh org of their own).
export async function createPersonalOrganization(
  tx: Prisma.TransactionClient,
  userId: string,
  userName: string
) {
  const organization = await tx.organization.create({
    data: { name: defaultOrganizationName(userName) },
  });
  await tx.organizationMembership.create({
    data: { userId, organizationId: organization.id, role: "OWNER" },
  });
  return organization;
}
