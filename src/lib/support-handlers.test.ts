import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestUser, createTestOrganization, addMembership, createTestEvent } from "@/lib/test-fixtures";
import {
  createSupportTicket,
  replyToSupportTicketAsBuyer,
  replyToSupportTicketAsOrganizer,
  resolveSupportTicket,
} from "@/lib/support-handlers";

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { user, organizationId: organization.id };
}

describe("createSupportTicket", () => {
  it("creates an OPEN ticket, derived organizationId from the event", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const buyer = await createTestUser();

    const result = await createSupportTicket(buyer.id, event.id, "Where's my ticket?", "I never got an email.");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ticket = await prisma.supportTicket.findUniqueOrThrow({ where: { id: result.ticketId } });
    expect(ticket.status).toBe("OPEN");
    expect(ticket.organizationId).toBe(organizationId);
    expect(ticket.buyerUserId).toBe(buyer.id);
  });

  it("does not require the buyer to have a prior order — any signed-in user may open a ticket", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const stranger = await createTestUser();

    const result = await createSupportTicket(stranger.id, event.id, "General question", "Is parking available?");
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown event", async () => {
    const buyer = await createTestUser();
    const result = await createSupportTicket(buyer.id, "does-not-exist", "Subject", "Body");
    expect(result.ok).toBe(false);
  });
});

describe("replyToSupportTicketAsBuyer / AsOrganizer", () => {
  async function openTicket() {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const buyer = await createTestUser();
    const result = await createSupportTicket(buyer.id, event.id, "Subject", "Body");
    if (!result.ok) throw new Error("setup failed");
    return { organizationId, buyer, ticketId: result.ticketId };
  }

  it("a buyer reply reopens a RESOLVED ticket", async () => {
    const { organizationId, buyer, ticketId } = await openTicket();
    await resolveSupportTicket(organizationId, ticketId);
    let ticket = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(ticket.status).toBe("RESOLVED");

    await replyToSupportTicketAsBuyer(buyer.id, ticketId, buyer.name, "Still waiting on this.");
    ticket = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(ticket.status).toBe("OPEN");
  });

  it("an organizer reply does not change status", async () => {
    const { organizationId, ticketId } = await openTicket();
    const owner = await createTestUser();
    await replyToSupportTicketAsOrganizer(organizationId, ticketId, owner.id, owner.name, "We'll look into it.");
    const ticket = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(ticket.status).toBe("OPEN");
  });

  it("rejects an organizer reply from a different organization", async () => {
    const { ticketId } = await openTicket();
    const { organizationId: otherOrgId, user: otherOwner } = await newOrganizer();
    await expect(
      replyToSupportTicketAsOrganizer(otherOrgId, ticketId, otherOwner.id, otherOwner.name, "Not yours")
    ).rejects.toThrow();
  });

  it("rejects a reply from a user who isn't the ticket's buyer", async () => {
    const { ticketId } = await openTicket();
    const stranger = await createTestUser();
    await expect(replyToSupportTicketAsBuyer(stranger.id, ticketId, stranger.name, "Not mine")).rejects.toThrow();
  });
});

describe("resolveSupportTicket", () => {
  it("is cross-org guarded", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const buyer = await createTestUser();
    const result = await createSupportTicket(buyer.id, event.id, "Subject", "Body");
    if (!result.ok) throw new Error("setup failed");

    const { organizationId: otherOrgId } = await newOrganizer();
    await expect(resolveSupportTicket(otherOrgId, result.ticketId)).rejects.toThrow();
  });

  it("is idempotent on an already-resolved ticket", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const buyer = await createTestUser();
    const result = await createSupportTicket(buyer.id, event.id, "Subject", "Body");
    if (!result.ok) throw new Error("setup failed");

    await resolveSupportTicket(organizationId, result.ticketId);
    const second = await resolveSupportTicket(organizationId, result.ticketId);
    expect(second.status).toBe("RESOLVED");
  });
});
