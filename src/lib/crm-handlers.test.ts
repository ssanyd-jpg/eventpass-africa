import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestOrganization, createTestUser, addMembership, createTestEvent, createPaidOrder } from "@/lib/test-fixtures";
import { handleSellTickets } from "@/lib/sync-handlers";
import { resolveBroadcastAudience, sendBroadcast, addCustomerNoteById } from "@/lib/crm-handlers";

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { user, organizationId: organization.id };
}

describe("resolveBroadcastAudience", () => {
  it("returns everyone who bought a ticket to the event, deduped", async () => {
    const { organizationId } = await newOrganizer();
    const buyer = await createTestUser({ name: "Amina" });
    const { event } = await createPaidOrder(organizationId, buyer.id, 100000);
    // A second order from the same buyer for the same event shouldn't
    // double them up in the audience.
    const tt = event.ticketTypes[0];
    await handleSellTickets(buyer.id, {
      clientId: "second-order",
      eventId: event.id,
      items: [{ ticketTypeId: tt.id, quantity: 1, codes: ["CODE-22222"] }],
    });

    const { recipients } = await resolveBroadcastAudience(organizationId, event.id);
    expect(recipients).toHaveLength(1);
    expect(recipients[0].id).toBe(buyer.id);
  });

  it("filters to only buyers of a specific ticket type when given", async () => {
    const { organizationId } = await newOrganizer();
    const vipBuyer = await createTestUser({ name: "VIP Buyer" });
    const generalBuyer = await createTestUser({ name: "General Buyer" });
    const event = await createTestEvent(organizationId, [
      { priceCents: 500000, quantityTotal: 10 },
      { priceCents: 100000, quantityTotal: 10 },
    ]);
    const [vipType, generalType] = event.ticketTypes;

    await handleSellTickets(vipBuyer.id, {
      clientId: "vip-order",
      eventId: event.id,
      items: [{ ticketTypeId: vipType.id, quantity: 1, codes: ["VIP-11111"] }],
    });
    await handleSellTickets(generalBuyer.id, {
      clientId: "general-order",
      eventId: event.id,
      items: [{ ticketTypeId: generalType.id, quantity: 1, codes: ["GEN-11111"] }],
    });

    const { recipients } = await resolveBroadcastAudience(organizationId, event.id, vipType.id);
    expect(recipients).toHaveLength(1);
    expect(recipients[0].id).toBe(vipBuyer.id);
  });

  it("rejects an event that belongs to a different organization", async () => {
    const { organizationId: organizationIdA } = await newOrganizer();
    const { organizationId: organizationIdB } = await newOrganizer();
    const event = await createTestEvent(organizationIdB);

    await expect(resolveBroadcastAudience(organizationIdA, event.id)).rejects.toThrow();
  });
});

describe("sendBroadcast", () => {
  it("creates one Broadcast row with the correct recipientCount and one NotificationLog row per recipient", async () => {
    const { organizationId } = await newOrganizer();
    const buyerA = await createTestUser({ name: "Amina" });
    const buyerB = await createTestUser({ name: "Baraka" });
    const { event } = await createPaidOrder(organizationId, buyerA.id, 100000);
    const tt = event.ticketTypes[0];
    await handleSellTickets(buyerB.id, {
      clientId: "buyer-b-order",
      eventId: event.id,
      items: [{ ticketTypeId: tt.id, quantity: 1, codes: ["CODE-33333"] }],
    });

    const result = await sendBroadcast(
      organizationId, event.id, null, "Gate opens at 5pm", "See you there!", "owner-id", "Owner Name"
    );

    expect(result.recipientCount).toBe(2);
    const broadcast = await prisma.broadcast.findUniqueOrThrow({ where: { id: result.broadcastId } });
    expect(broadcast.recipientCount).toBe(2);
    expect(broadcast.subject).toBe("Gate opens at 5pm");

    const logs = await prisma.notificationLog.findMany({ where: { type: "ORGANIZER_BROADCAST", subject: "Gate opens at 5pm" } });
    expect(logs).toHaveLength(2);
  });
});

describe("addCustomerNoteById", () => {
  it("succeeds for a real customer of the organization", async () => {
    const { organizationId } = await newOrganizer();
    const buyer = await createTestUser({ name: "Amina" });
    await createPaidOrder(organizationId, buyer.id, 100000);

    const note = await addCustomerNoteById(organizationId, buyer.id, "owner-id", "Owner Name", "Asked for a receipt.");
    expect(note.customerUserId).toBe(buyer.id);
    expect(note.body).toBe("Asked for a receipt.");
  });

  it("throws for a userId with no orders in this organization", async () => {
    const { organizationId } = await newOrganizer();
    const stranger = await createTestUser();

    await expect(
      addCustomerNoteById(organizationId, stranger.id, "owner-id", "Owner Name", "Should not work.")
    ).rejects.toThrow();
  });
});
