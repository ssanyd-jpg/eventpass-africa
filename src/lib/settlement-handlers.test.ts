import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestEvent, createTestUser } from "@/lib/test-fixtures";
import { handleSellTickets } from "@/lib/sync-handlers";
import { runSettlement } from "@/lib/settlement-handlers";

async function paidOrder(organizerId: string, priceCents: number, currency = "TZS") {
  const buyer = await createTestUser();
  const event = await createTestEvent(organizerId, [{ priceCents, quantityTotal: 10 }], currency);
  const tt = event.ticketTypes[0];
  await handleSellTickets(buyer.id, {
    clientId: `settle-${Date.now()}-${Math.random()}`,
    eventId: event.id,
    items: [{ ticketTypeId: tt.id, quantity: 1, codes: [`SET-${Date.now()}-${Math.random()}`] }],
  });
}

describe("runSettlement", () => {
  it("aggregates unsettled orders, applies the 8% platform fee, and marks them paid out", async () => {
    const organizer = await createTestUser();
    await prisma.mobileMoneyAccount.create({
      data: { provider: "MPESA_TZ", phoneNumber: "255700000001", accountName: "Org", organizerId: organizer.id },
    });
    await paidOrder(organizer.id, 100000); // TZS 1,000
    await paidOrder(organizer.id, 200000); // TZS 2,000

    const result = await runSettlement(organizer.id);

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
    const organizer = await createTestUser();
    await prisma.mobileMoneyAccount.create({
      data: { provider: "TIGO_PESA", phoneNumber: "255700000002", accountName: "Org", organizerId: organizer.id },
    });
    await paidOrder(organizer.id, 100000);

    const first = await runSettlement(organizer.id);
    expect(first.ok).toBe(true);
    expect(first.ordersSettled).toBe(1);

    const second = await runSettlement(organizer.id);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("NOTHING_TO_SETTLE");
  });

  it("refuses to run without a linked mobile money account", async () => {
    const organizer = await createTestUser();
    await paidOrder(organizer.id, 100000);

    const result = await runSettlement(organizer.id);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("NO_MOBILE_MONEY_ACCOUNT");
  });

  it("only settles the requesting organizer's own orders", async () => {
    const organizerA = await createTestUser();
    const organizerB = await createTestUser();
    await prisma.mobileMoneyAccount.create({
      data: { provider: "MPESA_TZ", phoneNumber: "255700000003", accountName: "A", organizerId: organizerA.id },
    });
    await paidOrder(organizerB.id, 500000); // belongs to organizerB, not A

    const result = await runSettlement(organizerA.id);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("NOTHING_TO_SETTLE");
  });

  it("settles each currency separately rather than mixing totals", async () => {
    const organizer = await createTestUser();
    await prisma.mobileMoneyAccount.create({
      data: { provider: "MPESA_TZ", phoneNumber: "255700000004", accountName: "Org", organizerId: organizer.id },
    });
    await paidOrder(organizer.id, 100000, "TZS"); // TZS 1,000
    await paidOrder(organizer.id, 5000, "USD"); // USD 50.00

    const result = await runSettlement(organizer.id);

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
