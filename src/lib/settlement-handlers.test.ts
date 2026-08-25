import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestEvent, createTestUser, createTestOrganization, addMembership } from "@/lib/test-fixtures";
import { handleSellTickets } from "@/lib/sync-handlers";
import { runSettlement } from "@/lib/settlement-handlers";

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { user, organizationId: organization.id };
}

async function paidOrder(organizationId: string, priceCents: number, currency = "TZS") {
  const buyer = await createTestUser();
  const event = await createTestEvent(organizationId, [{ priceCents, quantityTotal: 10 }], currency);
  const tt = event.ticketTypes[0];
  await handleSellTickets(buyer.id, {
    clientId: `settle-${Date.now()}-${Math.random()}`,
    eventId: event.id,
    items: [{ ticketTypeId: tt.id, quantity: 1, codes: [`SET-${Date.now()}-${Math.random()}`] }],
  });
}

describe("runSettlement", () => {
  it("aggregates unsettled orders, applies the 8% platform fee, and marks them paid out", async () => {
    const { organizationId } = await newOrganizer();
    await prisma.mobileMoneyAccount.create({
      data: { provider: "MPESA_TZ", phoneNumber: "255700000001", accountName: "Org", organizationId },
    });
    await paidOrder(organizationId, 100000); // TZS 1,000
    await paidOrder(organizationId, 200000); // TZS 2,000

    const result = await runSettlement(organizationId);

    expect(result.ok).toBe(true);
    expect(result.ordersSettled).toBe(2);
    expect(result.settlements).toHaveLength(1);
    expect(result.settlements[0].currency).toBe("TZS");
    expect(result.settlements[0].grossCents).toBe(300000);
    expect(result.settlements[0].platformFeeCents).toBe(24000); // 8% of 300000
    expect(result.settlements[0].netCents).toBe(276000);
    expect(result.settlements[0].status).toBe("PAID_OUT");
  });

  it("excludes orders already covered by a previous settlement", async () => {
    const { organizationId } = await newOrganizer();
    await prisma.mobileMoneyAccount.create({
      data: { provider: "TIGO_PESA", phoneNumber: "255700000002", accountName: "Org", organizationId },
    });
    await paidOrder(organizationId, 100000);

    const first = await runSettlement(organizationId);
    expect(first.ok).toBe(true);
    expect(first.ordersSettled).toBe(1);

    const second = await runSettlement(organizationId);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("NOTHING_TO_SETTLE");
  });

  it("refuses to run without a linked mobile money account", async () => {
    const { organizationId } = await newOrganizer();
    await paidOrder(organizationId, 100000);

    const result = await runSettlement(organizationId);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("NO_MOBILE_MONEY_ACCOUNT");
  });

  it("only settles the requesting organization's own orders", async () => {
    const { organizationId: organizationIdA } = await newOrganizer();
    const { organizationId: organizationIdB } = await newOrganizer();
    await prisma.mobileMoneyAccount.create({
      data: { provider: "MPESA_TZ", phoneNumber: "255700000003", accountName: "A", organizationId: organizationIdA },
    });
    await paidOrder(organizationIdB, 500000); // belongs to org B, not A

    const result = await runSettlement(organizationIdA);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("NOTHING_TO_SETTLE");
  });

  it("settles each currency separately rather than mixing totals", async () => {
    const { organizationId } = await newOrganizer();
    await prisma.mobileMoneyAccount.create({
      data: { provider: "MPESA_TZ", phoneNumber: "255700000004", accountName: "Org", organizationId },
    });
    await paidOrder(organizationId, 100000, "TZS"); // TZS 1,000
    await paidOrder(organizationId, 5000, "USD"); // USD 50.00

    const result = await runSettlement(organizationId);

    expect(result.ok).toBe(true);
    expect(result.ordersSettled).toBe(2);
    expect(result.settlements).toHaveLength(2);

    const tzs = result.settlements.find((s) => s.currency === "TZS")!;
    const usd = result.settlements.find((s) => s.currency === "USD")!;
    expect(tzs.grossCents).toBe(100000);
    expect(usd.grossCents).toBe(5000);
    // each settlement keeps its own reference/payout — never combined
    expect(tzs.payoutReference).not.toBe(usd.payoutReference);
  });
});
