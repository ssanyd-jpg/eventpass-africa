import { prisma } from "@/lib/prisma";
import { generateTicketCode } from "@/lib/format";

// Extracted from the customer/vendor dashboard pages for the same reason
// device-handlers.ts/crm-handlers.ts are separate from theirs: testable
// without HTTP/session plumbing.
//
// None of the three functions below touch the four scan/charge lookup
// handlers in sync-handlers.ts (handleCheckIn/handleCheckInVendor/
// handleChargeWallet/handleSponsorTap) — those keep doing
// findUnique({where:{code/badgeCode}}) against Ticket/Wallet/Vendor exactly
// as before. Replacing a credential just updates that same field in place
// and records the change in Credential as a side history/audit trail.

// Unlike client-generated codes (trusted, backed only by the DB unique
// constraint — see generateTicketCode()'s own doc comment), this is a
// deliberate server-side action a staff member is waiting on, so it's worth
// a small bounded retry rather than surfacing a raw collision error.
async function uniqueCode(check: (code: string) => Promise<boolean>): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const code = generateTicketCode();
    if (await check(code)) return code;
  }
  throw new Error("Could not generate a unique code, try again.");
}

export async function replaceTicketCode(
  organizationId: string,
  ticketId: string,
  actorUserId: string,
  actorName: string
) {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: { event: { select: { organizationId: true, title: true } } },
  });
  if (!ticket || ticket.event.organizationId !== organizationId) {
    throw new Error("Ticket not found.");
  }

  const code = await uniqueCode(async (c) => !(await prisma.ticket.findUnique({ where: { code: c } })));

  const updated = await prisma.$transaction(async (tx) => {
    await tx.credential.updateMany({
      where: { ticketId, status: "ACTIVE" },
      data: { status: "SUPERSEDED", supersededAt: new Date(), supersededByUserId: actorUserId },
    });
    const result = await tx.ticket.update({ where: { id: ticketId }, data: { code } });
    await tx.credential.create({
      data: { organizationId, ticketId, code, status: "ACTIVE", createdByUserId: actorUserId, createdByName: actorName },
    });
    return result;
  });
  return { ...updated, eventTitle: ticket.event.title };
}

export async function replaceWalletCode(
  organizationId: string,
  walletId: string,
  actorUserId: string,
  actorName: string
) {
  const wallet = await prisma.wallet.findUnique({
    where: { id: walletId },
    include: { event: { select: { organizationId: true, title: true } } },
  });
  if (!wallet || wallet.event.organizationId !== organizationId) {
    throw new Error("Wallet not found.");
  }

  const code = await uniqueCode(async (c) => !(await prisma.wallet.findUnique({ where: { code: c } })));

  const updated = await prisma.$transaction(async (tx) => {
    await tx.credential.updateMany({
      where: { walletId, status: "ACTIVE" },
      data: { status: "SUPERSEDED", supersededAt: new Date(), supersededByUserId: actorUserId },
    });
    const result = await tx.wallet.update({ where: { id: walletId }, data: { code } });
    await tx.credential.create({
      data: { organizationId, walletId, code, status: "ACTIVE", createdByUserId: actorUserId, createdByName: actorName },
    });
    return result;
  });
  return { ...updated, eventTitle: wallet.event.title };
}

// No extra status guard needed — a PENDING/REJECTED vendor's badgeCode is
// already null; the UI only offers this action on APPROVED vendors, same
// as the vendors page's existing status sections.
export async function replaceVendorBadgeCode(
  organizationId: string,
  vendorId: string,
  actorUserId: string,
  actorName: string
) {
  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    include: { event: { select: { organizationId: true } } },
  });
  if (!vendor || vendor.event.organizationId !== organizationId) {
    throw new Error("Vendor not found.");
  }

  const code = await uniqueCode(async (c) => !(await prisma.vendor.findUnique({ where: { badgeCode: c } })));

  return prisma.$transaction(async (tx) => {
    await tx.credential.updateMany({
      where: { vendorId, status: "ACTIVE" },
      data: { status: "SUPERSEDED", supersededAt: new Date(), supersededByUserId: actorUserId },
    });
    const result = await tx.vendor.update({ where: { id: vendorId }, data: { badgeCode: code } });
    await tx.credential.create({
      data: { organizationId, vendorId, code, status: "ACTIVE", createdByUserId: actorUserId, createdByName: actorName },
    });
    return result;
  });
}
