"use server";

import { auth } from "@/auth";
import { logAudit } from "@/lib/audit";
import { sendSponsorPortalLinkCore } from "@/lib/sponsor-auth";

// OWNER or STAFF, not GATE_CREW — matches vendors/actions.ts's own
// requireViewer(): routine day-to-day work, not a team-structure/irreversible
// action.
async function requireViewer() {
  const session = await auth();
  if (!session?.user?.id || session.user.organizationRole === "GATE_CREW") {
    throw new Error("Forbidden");
  }
  return session;
}

// Session 16's sponsor portal — see src/lib/sponsor-auth.ts. Lets an
// organiser (re-)send a sponsor's magic link manually, same reasoning as
// vendors/actions.ts's sendVendorPortalLink. The actual ownership check +
// send lives in sponsor-auth.ts, not here — every export of a "use server"
// file is a client-reachable RPC.
export async function sendSponsorPortalLink(sponsorId: string) {
  const session = await requireViewer();
  const actorName = session.user.name ?? session.user.email ?? "Unknown";
  const result = await sendSponsorPortalLinkCore(session.user.organizationId, sponsorId);
  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName,
    action: "SPONSOR_PORTAL_LINK_SENT",
    summary: `Sent a sponsor portal link to "${result.sponsorName}"`,
  });
}
