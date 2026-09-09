import { describe, expect, it } from "vitest";
import {
  createTestUser,
  createTestOrganization,
  addMembership,
  createTestEvent,
  createTestVendor,
  createTestWallet,
} from "@/lib/test-fixtures";
import { handleChargeWallet } from "@/lib/sync-handlers";
import { getVendorDashboardData } from "@/lib/vendor-dashboard-data";

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { user, organizationId: organization.id };
}

describe("getVendorDashboardData", () => {
  it("only reflects the requested vendor's own sales, never another vendor's on the same event", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const buyer = await createTestUser();
    const wallet = await createTestWallet(event.id, buyer.id, { balanceCents: 100000 });

    const vendorA = await createTestVendor(event.id, { name: "Vendor A" });
    const vendorB = await createTestVendor(event.id, { name: "Vendor B" });

    await handleChargeWallet(buyer.id, organizationId, {
      clientId: `chg-a-${Date.now()}`,
      walletCode: wallet.code,
      vendorId: vendorA.id,
      eventId: event.id,
      amountCents: 5000,
      item: "Vendor A special",
    });
    await handleChargeWallet(buyer.id, organizationId, {
      clientId: `chg-b-${Date.now()}`,
      walletCode: wallet.code,
      vendorId: vendorB.id,
      eventId: event.id,
      amountCents: 9000,
      item: "Vendor B special",
    });

    const dataA = await getVendorDashboardData(vendorA.id);
    expect(dataA).not.toBeNull();
    expect(dataA!.vendorName).toBe("Vendor A");
    expect(dataA!.stats.todaysSalesTotalCents).toBe(5000);
    expect(dataA!.stats.transactionCount).toBe(1);
    expect(dataA!.transactions).toHaveLength(1);
    expect(dataA!.transactions[0].item).toBe("Vendor A special");
    expect(dataA!.topItems.map((t) => t.item)).toEqual(["Vendor A special"]);
    // Vendor B's data must never leak into vendor A's response.
    expect(dataA!.stats.todaysSalesTotalCents).not.toBe(14000);
    expect(JSON.stringify(dataA)).not.toContain("Vendor B special");

    const dataB = await getVendorDashboardData(vendorB.id);
    expect(dataB!.vendorName).toBe("Vendor B");
    expect(dataB!.stats.todaysSalesTotalCents).toBe(9000);
    expect(JSON.stringify(dataB)).not.toContain("Vendor A special");
  });

  it("returns null for a vendor id that doesn't exist", async () => {
    const data = await getVendorDashboardData("nonexistent-vendor-id");
    expect(data).toBeNull();
  });
});
