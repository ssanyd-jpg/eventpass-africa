import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestUser, createTestOrganization, addMembership, createTestEvent } from "@/lib/test-fixtures";
import { handleSellTickets } from "@/lib/sync-handlers";
import { loyaltyTierFromOrdersCount, getMyLoyaltyStatuses } from "@/lib/loyalty";

describe("loyaltyTierFromOrdersCount", () => {
  it("returns NEW for 0 or 1 orders", () => {
    expect(loyaltyTierFromOrdersCount(0)).toBe("NEW");
    expect(loyaltyTierFromOrdersCount(1)).toBe("NEW");
  });

  it("returns REPEAT for 2 to 4 orders", () => {
    expect(loyaltyTierFromOrdersCount(2)).toBe("REPEAT");
    expect(loyaltyTierFromOrdersCount(4)).toBe("REPEAT");
  });

  it("returns VIP for 5 or more orders", () => {
    expect(loyaltyTierFromOrdersCount(5)).toBe("VIP");
    expect(loyaltyTierFromOrdersCount(10)).toBe("VIP");
  });
});

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { user, organizationId: organization.id };
}

async function buyTicket(organizationId: string, buyerId: string) {
  const event = await createTestEvent(organizationId);
  const tt = event.ticketTypes[0];
  return handleSellTickets(buyerId, {
    clientId: `loyalty-${Date.now()}-${Math.random()}`,
    eventId: event.id,
    items: [{ ticketTypeId: tt.id, quantity: 1, codes: [`LOY-${Date.now()}-${Math.random()}`] }],
  });
}

describe("getMyLoyaltyStatuses", () => {
  it("groups orders per-organization and computes the correct tier, excluding refunded orders", async () => {
    const buyer = await createTestUser();
    const orgA = await newOrganizer();
    const orgB = await newOrganizer();

    // 2 orders with orgA -> REPEAT
    await buyTicket(orgA.organizationId, buyer.id);
    const secondOrder = await buyTicket(orgA.organizationId, buyer.id);
    // 1 order with orgB -> NEW
    await buyTicket(orgB.organizationId, buyer.id);

    // Refund one of orgA's orders down to 1 real order — still REPEAT
    // would be wrong if refunds counted; but here we keep 2 PAID orders
    // and separately confirm a REFUNDED one is excluded.
    const refundedEvent = await buyTicket(orgA.organizationId, buyer.id);
    await prisma.order.update({ where: { id: refundedEvent.order.id }, data: { status: "REFUNDED" } });

    const statuses = await getMyLoyaltyStatuses(buyer.id);

    const forOrgA = statuses.find((s) => s.organizationId === orgA.organizationId);
    const forOrgB = statuses.find((s) => s.organizationId === orgB.organizationId);

    expect(forOrgA?.ordersCount).toBe(2); // the refunded one doesn't count
    expect(forOrgA?.tier).toBe("REPEAT");
    expect(forOrgB?.ordersCount).toBe(1);
    expect(forOrgB?.tier).toBe("NEW");
    void secondOrder;
  }, 120000); // four sequential handleSellTickets transactions — this
  // environment's Neon connection can be slow under load

  it("returns an empty list for a buyer with no orders", async () => {
    const buyer = await createTestUser();
    expect(await getMyLoyaltyStatuses(buyer.id)).toEqual([]);
  });
});
