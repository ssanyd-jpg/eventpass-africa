import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/format";
import {
  createTestUser,
  createTestOrganization,
  addMembership,
  createTestEvent,
  createTestVendor,
  createTestWallet,
} from "@/lib/test-fixtures";
import { handleChargeWallet } from "@/lib/sync-handlers";
import { markVendorSettlementProcessingCore, markVendorSettlementProcessedCore } from "@/lib/vendor-settlement";

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { user, organizationId: organization.id };
}

// Session 6's own documented gotcha (see sync-handlers.test.ts's low-wallet-
// balance SMS tests): handleChargeWallet/markVendorSettlementProcessedCore
// never normalize a phone at read/send time, only User.phone gets
// normalized at its one write point — so test phones need to already be
// E.164 with a unique-per-test suffix to avoid cross-test collisions on the
// shared Neon test database.
function uniquePhone() {
  return `+2557${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 13);
}

describe("markVendorSettlementProcessedCore", () => {
  it("freezes the completed-sales total, marks SETTLED, and sends an SMS with the amount", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const buyer = await createTestUser();
    const wallet = await createTestWallet(event.id, buyer.id, { balanceCents: 100000 });
    const phone = uniquePhone();
    const vendor = await createTestVendor(event.id);
    await prisma.vendor.update({ where: { id: vendor.id }, data: { contactPhone: phone } });

    await handleChargeWallet(buyer.id, organizationId, {
      clientId: `settle-${Date.now()}-1`,
      walletCode: wallet.code,
      vendorId: vendor.id,
      eventId: event.id,
      amountCents: 7000,
    });
    await handleChargeWallet(buyer.id, organizationId, {
      clientId: `settle-${Date.now()}-2`,
      walletCode: wallet.code,
      vendorId: vendor.id,
      eventId: event.id,
      amountCents: 3000,
    });

    const result = await markVendorSettlementProcessedCore(organizationId, vendor.id);
    expect(result.amountCents).toBe(10000);

    const updated = await prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(updated.settlementStatus).toBe("SETTLED");
    expect(updated.settlementAmountCents).toBe(10000);
    expect(updated.settlementProcessedAt).not.toBeNull();

    const log = await prisma.notificationLog.findFirstOrThrow({
      where: { type: "VENDOR_SETTLEMENT_PROCESSED", recipient: phone },
      orderBy: { createdAt: "desc" },
    });
    expect(log.channel).toBe("SMS");
    expect(log.body).toContain(formatCents(10000, updated.currency));
  });

  it("does not send an SMS when the vendor has no contact phone on file", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const vendor = await createTestVendor(event.id);
    expect(vendor.contactPhone).toBe("");

    const before = await prisma.notificationLog.count({ where: { type: "VENDOR_SETTLEMENT_PROCESSED" } });
    await markVendorSettlementProcessedCore(organizationId, vendor.id);
    const after = await prisma.notificationLog.count({ where: { type: "VENDOR_SETTLEMENT_PROCESSED" } });
    expect(after).toBe(before);

    const updated = await prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(updated.settlementStatus).toBe("SETTLED");
  });

  it("throws for a vendor belonging to a different organization", async () => {
    const { organizationId: ownerOrgId } = await newOrganizer();
    const { organizationId: otherOrgId } = await newOrganizer();
    const event = await createTestEvent(ownerOrgId);
    const vendor = await createTestVendor(event.id);

    await expect(markVendorSettlementProcessedCore(otherOrgId, vendor.id)).rejects.toThrow("Forbidden");
  });
});

describe("markVendorSettlementProcessingCore", () => {
  it("marks the vendor PROCESSING without sending any notification", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const phone = uniquePhone();
    const vendor = await createTestVendor(event.id);
    await prisma.vendor.update({ where: { id: vendor.id }, data: { contactPhone: phone } });

    const before = await prisma.notificationLog.count({ where: { recipient: phone } });
    await markVendorSettlementProcessingCore(organizationId, vendor.id);
    const after = await prisma.notificationLog.count({ where: { recipient: phone } });
    expect(after).toBe(before);

    const updated = await prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(updated.settlementStatus).toBe("PROCESSING");
  });
});
