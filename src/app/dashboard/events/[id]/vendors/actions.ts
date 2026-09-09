"use server";

import { auth } from "@/auth";
import { logAudit } from "@/lib/audit";
import { formatCents } from "@/lib/format";
import { sendVendorPortalLinkCore } from "@/lib/vendor-auth";
import { markVendorSettlementProcessingCore, markVendorSettlementProcessedCore } from "@/lib/vendor-settlement";
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

// Session 8's vendor portal — see src/lib/vendor-auth.ts. Lets an organiser
// (re-)send a vendor's magic link manually (a vendor who lost the original
// email, or who never got one at approval time) without the vendor having
// to know their own event's slug and self-serve it from /vendor/login. The
// actual ownership check + send lives in vendor-auth.ts, not here — every
// export of a "use server" file is a client-reachable RPC, so the real
// logic can't live in a function this file exports directly (see that
// file's header comment).
export async function sendVendorPortalLink(vendorId: string) {
  const session = await requireViewer();
  const actorName = session.user.name ?? session.user.email ?? "Unknown";
  const result = await sendVendorPortalLinkCore(session.user.organizationId, vendorId);
  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName,
    action: "VENDOR_PORTAL_LINK_SENT",
    summary: `Sent a vendor portal link to "${result.vendorName}"`,
  });
}

export async function markVendorSettlementProcessing(vendorId: string) {
  const session = await requireViewer();
  const actorName = session.user.name ?? session.user.email ?? "Unknown";
  const vendor = await markVendorSettlementProcessingCore(session.user.organizationId, vendorId);
  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName,
    action: "VENDOR_SETTLEMENT_PROCESSING",
    summary: `Marked "${vendor.name}"'s settlement as processing`,
  });
}

// Freezes the vendor's current completed-sales total as the payout amount,
// marks the settlement SETTLED, and fires the vendor-facing SMS (point 5 of
// the Session 8 spec) — all in markVendorSettlementProcessedCore, same
// "logic lives outside the use-server file" reasoning as sendVendorPortalLink.
export async function markVendorSettlementProcessed(vendorId: string) {
  const session = await requireViewer();
  const actorName = session.user.name ?? session.user.email ?? "Unknown";
  const { vendor, amountCents } = await markVendorSettlementProcessedCore(session.user.organizationId, vendorId);
  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName,
    action: "VENDOR_SETTLEMENT_PROCESSED",
    summary: `Settled "${vendor.name}"'s payout of ${formatCents(amountCents, vendor.currency)}`,
  });
  return { amountCents };
}
