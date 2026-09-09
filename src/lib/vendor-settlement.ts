import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/format";
import { sendNotification } from "@/lib/notifications";
import { normalizeTanzaniaPhone } from "@/lib/sms";

// Kept out of dashboard/events/[id]/vendors/actions.ts on purpose: every
// exported async function in a "use server" file is reachable as a Server
// Action RPC by the client, so the actual organizationId-ownership check
// and business logic live here, in a plain module, and the "use server"
// file stays a thin requireViewer()-then-delegate wrapper — same reasoning
// this codebase already applies everywhere else (sync-handlers.ts holds
// the logic, push/route.ts just dispatches to it).
export async function getOwnedVendor(organizationId: string, vendorId: string) {
  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    include: { event: { select: { organizationId: true } } },
  });
  if (!vendor || vendor.event.organizationId !== organizationId) {
    throw new Error("Forbidden");
  }
  return vendor;
}

export async function markVendorSettlementProcessingCore(organizationId: string, vendorId: string) {
  const vendor = await getOwnedVendor(organizationId, vendorId);
  await prisma.vendor.update({ where: { id: vendor.id }, data: { settlementStatus: "PROCESSING" } });
  return vendor;
}

// Freezes the vendor's current completed-sales total as the payout amount
// and marks the settlement SETTLED — see the settlementStatus/
// settlementAmountCents comment on the Vendor model for why this is a
// snapshot, not a live figure. Fires the vendor-facing SMS this same step
// (point 5 of the Session 8 spec: "when the organiser marks a vendor
// settlement as PROCESSED, send the vendor an SMS"). Best-effort/skipped
// silently when the vendor has no contact phone, same discipline every
// other SMS send in this codebase (low-balance, wristband-provisioned) uses.
export async function markVendorSettlementProcessedCore(organizationId: string, vendorId: string) {
  const vendor = await getOwnedVendor(organizationId, vendorId);

  const totals = await prisma.walletTransaction.aggregate({
    where: { vendorId: vendor.id, type: "SALE", status: "COMPLETED" },
    _sum: { amountCents: true },
  });
  const amountCents = totals._sum.amountCents ?? 0;

  await prisma.vendor.update({
    where: { id: vendor.id },
    data: { settlementStatus: "SETTLED", settlementAmountCents: amountCents, settlementProcessedAt: new Date() },
  });

  if (vendor.contactPhone) {
    const dashboardUrl = `${process.env.NEXTAUTH_URL ?? ""}/vendor/${vendor.id}/dashboard`;
    await sendNotification({
      type: "VENDOR_SETTLEMENT_PROCESSED",
      channel: "SMS",
      recipient: normalizeTanzaniaPhone(vendor.contactPhone),
      subject: "Settlement paid out",
      body: `Your Chaap settlement of ${formatCents(amountCents, vendor.currency)} has been paid out. View details: ${dashboardUrl}`,
    });
  }

  return { vendor, amountCents };
}
