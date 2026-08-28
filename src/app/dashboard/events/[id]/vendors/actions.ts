"use server";

import { auth } from "@/auth";
import { logAudit } from "@/lib/audit";
import { replaceVendorBadgeCode as replaceVendorBadgeCodeById } from "@/lib/credential-handlers";

// OWNER or STAFF, not GATE_CREW — matches dashboard/customers/actions.ts's
// requireViewer(): routine day-to-day work, not a team-structure/irreversible
// action.
async function requireViewer() {
  const session = await auth();
  if (!session?.user?.id || session.user.organizationRole === "GATE_CREW") {
    throw new Error("Forbidden");
  }
  return session;
}

export async function replaceVendorBadgeCode(vendorId: string) {
  const session = await requireViewer();
  const actorName = session.user.name ?? session.user.email ?? "Unknown";
  const vendor = await replaceVendorBadgeCodeById(session.user.organizationId, vendorId, session.user.id, actorName);
  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName,
    action: "CREDENTIAL_REPLACED",
    summary: `Replaced badge for vendor "${vendor.name}"`,
  });
  return vendor;
}
