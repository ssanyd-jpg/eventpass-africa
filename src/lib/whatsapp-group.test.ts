import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { handleSellTickets } from "@/lib/sync-handlers";
import {
  sendGroupInvite,
  sendPendingGroupInvites,
  sendGroupArchiveMessage,
  getGroupOptInStats,
  shouldShowRevokeBanner,
} from "@/lib/whatsapp-group";
import { createTestUser, createTestOrganization, addMembership, createTestEvent } from "@/lib/test-fixtures";

const GROUP_LINK = "https://chat.whatsapp.com/test-group-link";

async function createGroupEnabledEvent(organizationId: string) {
  const event = await createTestEvent(organizationId);
  return prisma.event.update({
    where: { id: event.id },
    data: { whatsappGroupEnabled: true, whatsappGroupLink: GROUP_LINK },
  });
}

async function buyTicket(buyerId: string, eventId: string) {
  const tt = await prisma.ticketType.findFirstOrThrow({ where: { eventId } });
  const result = await handleSellTickets(buyerId, {
    clientId: `order-${Date.now()}-${Math.random()}`,
    eventId,
    items: [{ ticketTypeId: tt.id, quantity: 1, codes: [`code-${Date.now()}-${Math.random()}`] }],
  });
  return result.order!;
}

describe("whatsapp-group", () => {
  it("sends the group invite as soon as the order completes in handleSellTickets", async () => {
    const org = await createTestOrganization();
    const event = await createGroupEnabledEvent(org.id);
    const buyer = await createTestUser();
    await prisma.user.update({ where: { id: buyer.id }, data: { phone: "+255700000010" } });
    await addMembership(org.id, buyer.id, "STAFF");

    const order = await buyTicket(buyer.id, event.id);

    const ticket = await prisma.ticket.findFirstOrThrow({ where: { orderId: order.id } });
    expect(ticket.whatsappGroupOptedIn).toBe(true);
    expect(ticket.whatsappGroupInviteSentAt).not.toBeNull();

    const log = await prisma.notificationLog.findFirst({
      where: { type: "WHATSAPP_GROUP_INVITE_SENT", recipient: "+255700000010" },
    });
    expect(log).not.toBeNull();
  });

  it("never sends the same invite twice", async () => {
    const org = await createTestOrganization();
    const event = await createGroupEnabledEvent(org.id);
    const buyer = await createTestUser();
    await prisma.user.update({ where: { id: buyer.id }, data: { phone: "+255700000011" } });
    await addMembership(org.id, buyer.id, "STAFF");

    const order = await buyTicket(buyer.id, event.id);
    const ticket = await prisma.ticket.findFirstOrThrow({ where: { orderId: order.id } });
    const firstSentAt = ticket.whatsappGroupInviteSentAt;

    const result = await sendGroupInvite(ticket.id);
    expect(result).toEqual({ sent: false, reason: "ALREADY_SENT" });

    const unchanged = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(unchanged.whatsappGroupInviteSentAt).toEqual(firstSentAt);
  });

  it("respects opt-out — an opted-out ticket is skipped by the pending-invites batch", async () => {
    const org = await createTestOrganization();
    const event = await createGroupEnabledEvent(org.id);
    const buyer = await createTestUser();
    await addMembership(org.id, buyer.id, "STAFF");

    // Opted in, but never invited (e.g. the organiser pasted the link in
    // after this ticket was created) — then the attendee opts back out
    // before the organiser gets a chance to send invites.
    const tt = await prisma.ticketType.findFirstOrThrow({ where: { eventId: event.id } });
    const order = await prisma.order.create({
      data: { status: "PAID", totalCents: 0, userId: buyer.id, eventId: event.id },
    });
    const ticket = await prisma.ticket.create({
      data: {
        code: `opt-out-${Date.now()}`,
        eventId: event.id,
        ticketTypeId: tt.id,
        orderId: order.id,
        whatsappGroupOptedIn: true,
      },
    });
    await prisma.ticket.update({ where: { id: ticket.id }, data: { whatsappGroupOptedIn: false } });

    const { sentCount } = await sendPendingGroupInvites(event.id);
    expect(sentCount).toBe(0);

    const unchanged = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(unchanged.whatsappGroupInviteSentAt).toBeNull();
  });

  it("sends the archive message once the event has ended", async () => {
    const org = await createTestOrganization();
    const event = await createGroupEnabledEvent(org.id);
    await prisma.event.update({
      where: { id: event.id },
      data: { startsAt: new Date(Date.now() - 2 * 86400000), endsAt: new Date(Date.now() - 86400000) },
    });
    const buyer = await createTestUser();
    await prisma.user.update({ where: { id: buyer.id }, data: { phone: "+255700000012" } });
    await addMembership(org.id, buyer.id, "STAFF");
    await buyTicket(buyer.id, event.id);

    const result = await sendGroupArchiveMessage(event.id);
    expect(result.sent).toBe(true);
    expect(result.notifiedCount).toBe(1);

    const updated = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
    expect(updated.whatsappGroupArchivedAt).not.toBeNull();

    const log = await prisma.notificationLog.findFirst({
      where: { type: "WHATSAPP_GROUP_ARCHIVED", recipient: "+255700000012" },
    });
    expect(log).not.toBeNull();
  });

  it("never sends the archive message twice", async () => {
    const org = await createTestOrganization();
    const event = await createGroupEnabledEvent(org.id);
    await prisma.event.update({
      where: { id: event.id },
      data: { startsAt: new Date(Date.now() - 2 * 86400000), endsAt: new Date(Date.now() - 86400000) },
    });

    const first = await sendGroupArchiveMessage(event.id);
    expect(first.sent).toBe(true);

    const second = await sendGroupArchiveMessage(event.id);
    expect(second).toEqual({ sent: false, notifiedCount: 0 });
  });

  it("does not send the archive message before the event has ended", async () => {
    const org = await createTestOrganization();
    const event = await createGroupEnabledEvent(org.id); // default startsAt is now + 1 day

    const result = await sendGroupArchiveMessage(event.id);
    expect(result).toEqual({ sent: false, notifiedCount: 0 });

    const unchanged = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
    expect(unchanged.whatsappGroupArchivedAt).toBeNull();
  });

  it("shows the revoke-link banner only once 24h have passed since the event ended", async () => {
    const enabledEvent = { whatsappGroupEnabled: true, startsAt: new Date(Date.now() - 23 * 3600000) };
    expect(shouldShowRevokeBanner(enabledEvent)).toBe(false);

    const pastThreshold = { whatsappGroupEnabled: true, startsAt: new Date(Date.now() - 25 * 3600000) };
    expect(shouldShowRevokeBanner(pastThreshold)).toBe(true);

    const alreadyRevoked = { ...pastThreshold, whatsappGroupLinkRevokedAt: new Date() };
    expect(shouldShowRevokeBanner(alreadyRevoked)).toBe(false);

    const featureOff = { whatsappGroupEnabled: false, startsAt: new Date(Date.now() - 25 * 3600000) };
    expect(shouldShowRevokeBanner(featureOff)).toBe(false);
  });

  it("reports accurate opt-in/invite-sent stats", async () => {
    const org = await createTestOrganization();
    const event = await createGroupEnabledEvent(org.id);
    const buyerA = await createTestUser();
    const buyerB = await createTestUser();
    await prisma.user.update({ where: { id: buyerA.id }, data: { phone: "+255700000013" } });
    // buyerB has no phone — opted in by ticket creation, but the invite can
    // never actually go out, so it should count toward optedInCount but not
    // invitesSentCount.
    await addMembership(org.id, buyerA.id, "STAFF");
    await addMembership(org.id, buyerB.id, "STAFF");
    await buyTicket(buyerA.id, event.id);
    await buyTicket(buyerB.id, event.id);

    const stats = await getGroupOptInStats(event.id);
    expect(stats.optedInCount).toBe(2);
    expect(stats.invitesSentCount).toBe(1);
    expect(stats.archivedAt).toBeNull();
  });

  it("never sends an invite when the event has no group link set", async () => {
    const org = await createTestOrganization();
    const event = await createTestEvent(org.id);
    await prisma.event.update({ where: { id: event.id }, data: { whatsappGroupEnabled: true, whatsappGroupLink: null } });
    const buyer = await createTestUser();
    await prisma.user.update({ where: { id: buyer.id }, data: { phone: "+255700000014" } });
    await addMembership(org.id, buyer.id, "STAFF");

    const order = await buyTicket(buyer.id, event.id);
    const ticket = await prisma.ticket.findFirstOrThrow({ where: { orderId: order.id } });
    expect(ticket.whatsappGroupInviteSentAt).toBeNull();
  });

  it("never sends an invite when whatsappGroupEnabled is false", async () => {
    const org = await createTestOrganization();
    const event = await createTestEvent(org.id); // whatsappGroupEnabled defaults false
    const buyer = await createTestUser();
    await prisma.user.update({ where: { id: buyer.id }, data: { phone: "+255700000015" } });
    await addMembership(org.id, buyer.id, "STAFF");

    const order = await buyTicket(buyer.id, event.id);
    const ticket = await prisma.ticket.findFirstOrThrow({ where: { orderId: order.id } });
    expect(ticket.whatsappGroupOptedIn).toBe(false);
    expect(ticket.whatsappGroupInviteSentAt).toBeNull();
  });
});
