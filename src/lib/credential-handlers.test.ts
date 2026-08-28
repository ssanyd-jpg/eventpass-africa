import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createTestOrganization,
  createTestUser,
  addMembership,
  createTestEvent,
  createTestVendor,
  createTestWallet,
  createPaidOrder,
} from "@/lib/test-fixtures";
import { replaceTicketCode, replaceWalletCode, replaceVendorBadgeCode } from "@/lib/credential-handlers";

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { user, organizationId: organization.id };
}

describe("replaceTicketCode", () => {
  it("changes the ticket's code so the old code no longer resolves and the new one does", async () => {
    const { organizationId } = await newOrganizer();
    const buyer = await createTestUser();
    const { order } = await createPaidOrder(organizationId, buyer.id, 100000);
    const oldCode = order.tickets[0].code;
    const ticketId = order.tickets[0].id;

    await replaceTicketCode(organizationId, ticketId, "owner-id", "Owner Name");

    const byOldCode = await prisma.ticket.findUnique({ where: { code: oldCode } });
    expect(byOldCode).toBeNull();
    const updated = await prisma.ticket.findUnique({ where: { id: ticketId } });
    expect(updated?.code).not.toBe(oldCode);
    const byNewCode = await prisma.ticket.findUnique({ where: { code: updated!.code } });
    expect(byNewCode?.id).toBe(ticketId);
  });

  it("supersedes the old Credential row and creates a new ACTIVE one, chaining across multiple replacements", async () => {
    const { organizationId } = await newOrganizer();
    const buyer = await createTestUser();
    const { order } = await createPaidOrder(organizationId, buyer.id, 100000);
    const ticketId = order.tickets[0].id;

    await replaceTicketCode(organizationId, ticketId, "owner-id", "Owner Name");
    await replaceTicketCode(organizationId, ticketId, "owner-id", "Owner Name");

    const history = await prisma.credential.findMany({ where: { ticketId }, orderBy: { createdAt: "asc" } });
    expect(history).toHaveLength(2);
    expect(history[0].status).toBe("SUPERSEDED");
    expect(history[0].supersededAt).not.toBeNull();
    expect(history[0].supersededByUserId).toBe("owner-id");
    expect(history[1].status).toBe("ACTIVE");
    expect(history[1].supersededAt).toBeNull();
  });

  it("throws when the ticket belongs to a different organization", async () => {
    const { organizationId: organizationIdA } = await newOrganizer();
    const { organizationId: organizationIdB } = await newOrganizer();
    const buyer = await createTestUser();
    const { order } = await createPaidOrder(organizationIdA, buyer.id, 100000);

    await expect(
      replaceTicketCode(organizationIdB, order.tickets[0].id, "owner-id", "Owner Name")
    ).rejects.toThrow();
  });
});

describe("replaceWalletCode", () => {
  it("changes the wallet's code so the old code no longer resolves and the new one does", async () => {
    const { organizationId } = await newOrganizer();
    const owner = await createTestUser();
    const event = await createTestEvent(organizationId);
    const wallet = await createTestWallet(event.id, owner.id);

    await replaceWalletCode(organizationId, wallet.id, "owner-id", "Owner Name");

    const byOldCode = await prisma.wallet.findUnique({ where: { code: wallet.code } });
    expect(byOldCode).toBeNull();
    const updated = await prisma.wallet.findUnique({ where: { id: wallet.id } });
    expect(updated?.code).not.toBe(wallet.code);
  });

  it("throws when the wallet belongs to a different organization", async () => {
    const { organizationId: organizationIdA } = await newOrganizer();
    const { organizationId: organizationIdB } = await newOrganizer();
    const owner = await createTestUser();
    const event = await createTestEvent(organizationIdA);
    const wallet = await createTestWallet(event.id, owner.id);

    await expect(replaceWalletCode(organizationIdB, wallet.id, "owner-id", "Owner Name")).rejects.toThrow();
  });
});

describe("replaceVendorBadgeCode", () => {
  it("changes the vendor's badge code so the old code no longer resolves and the new one does", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const vendor = await createTestVendor(event.id);

    await replaceVendorBadgeCode(organizationId, vendor.id, "owner-id", "Owner Name");

    const byOldCode = await prisma.vendor.findUnique({ where: { badgeCode: vendor.badgeCode! } });
    expect(byOldCode).toBeNull();
    const updated = await prisma.vendor.findUnique({ where: { id: vendor.id } });
    expect(updated?.badgeCode).not.toBe(vendor.badgeCode);
  });

  it("throws when the vendor belongs to a different organization", async () => {
    const { organizationId: organizationIdA } = await newOrganizer();
    const { organizationId: organizationIdB } = await newOrganizer();
    const event = await createTestEvent(organizationIdA);
    const vendor = await createTestVendor(event.id);

    await expect(replaceVendorBadgeCode(organizationIdB, vendor.id, "owner-id", "Owner Name")).rejects.toThrow();
  });
});
