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
  userName: string,
  options: {
    // true for the "Buy tickets & attend events" signup path, false (the
    // column default) for "Organise & manage events" — see
    // Organization.isAttendeeOrg's own schema comment.
    isAttendeeOrg?: boolean;
    // Organiser signup collects a company/organisation name; attendee
    // signup doesn't, so this falls back to defaultOrganizationName.
    organizationName?: string;
  } = {}
) {
  const organization = await tx.organization.create({
    data: {
      name: options.organizationName?.trim() || defaultOrganizationName(userName),
      isAttendeeOrg: options.isAttendeeOrg ?? false,
    },
  });
  await tx.organizationMembership.create({
    data: { userId, organizationId: organization.id, role: "OWNER" },
  });
  return organization;
}
