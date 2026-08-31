import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestUser, createTestOrganization, addMembership, createTestEvent } from "@/lib/test-fixtures";
import { handleSellTickets } from "@/lib/sync-handlers";
import { createTransfer, getTransferByToken, acceptTransfer, cancelTransfer } from "@/lib/ticket-transfer";

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { user, organizationId: organization.id };
}

async function soldTicket(overrides: { checkedIn?: boolean } = {}) {
  const { organizationId } = await newOrganizer();
  const buyer = await createTestUser();
  const event = await createTestEvent(organizationId);
  const tt = event.ticketTypes[0];
  const sale = await handleSellTickets(buyer.id, {
    clientId: `transfer-${Date.now()}-${Math.random()}`,
    eventId: event.id,
    items: [{ ticketTypeId: tt.id, quantity: 1, codes: [`TR-${Date.now()}-${Math.random()}`] }],
  });
  const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: sale.order.tickets[0].id } });
  if (overrides.checkedIn) {
    await prisma.ticket.update({ where: { id: ticket.id }, data: { checkedIn: true } });
  }
  return { buyer, ticketId: ticket.id, event };
}

// Real Postgres, no per-test reset — every test needing a recipient account
// needs its own email, or a later prisma.user.create() collides on the
// unique email constraint against an earlier test's row.
function uniqueEmail() {
  return `recipient-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

// Extracts the raw token this test just sent, by reading the resulting
// NotificationLog row's body — createTransfer never returns the raw token
// itself (only the hash is persisted), same discipline as OrganizationInvite.
async function rawTokenFor(toEmail: string) {
  const log = await prisma.notificationLog.findFirstOrThrow({
    where: { type: "TICKET_TRANSFER", recipient: toEmail },
    orderBy: { createdAt: "desc" },
  });
  const match = log.body.match(/\/tickets\/transfer\/([a-f0-9]+)/);
  if (!match) throw new Error("No token found in notification body");
  return match[1];
}

describe("createTransfer", () => {
  it("creates a PENDING transfer and logs a notification", async () => {
    const { buyer, ticketId } = await soldTicket();
    const result = await createTransfer(buyer.id, ticketId, "Recipient@Example.com");
    expect(result.ok).toBe(true);

    const stored = await prisma.ticketTransfer.findFirstOrThrow({ where: { ticketId } });
    expect(stored.status).toBe("PENDING");
    expect(stored.toEmail).toBe("recipient@example.com"); // normalized
  });

  it("rejects transferring a ticket you don't hold", async () => {
    const { ticketId } = await soldTicket();
    const stranger = await createTestUser();
    const result = await createTransfer(stranger.id, ticketId, "someone@example.com");
    expect(result.ok).toBe(false);
  });

  it("rejects transferring an already-checked-in ticket", async () => {
    const { buyer, ticketId } = await soldTicket({ checkedIn: true });
    const result = await createTransfer(buyer.id, ticketId, "someone@example.com");
    expect(result.ok).toBe(false);
  });
});

describe("acceptTransfer", () => {
  it("flips currentHolderUserId and marks the transfer ACCEPTED", async () => {
    const { buyer, ticketId } = await soldTicket();
    const email = uniqueEmail();
    await createTransfer(buyer.id, ticketId, email);
    const token = await rawTokenFor(email);

    const recipient = await createTestUser({ email });
    const result = await acceptTransfer(token, recipient.id, email);

    expect(result.ok).toBe(true);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(ticket.currentHolderUserId).toBe(recipient.id);
    const transfer = await prisma.ticketTransfer.findFirstOrThrow({ where: { ticketId } });
    expect(transfer.status).toBe("ACCEPTED");
    expect(transfer.acceptedByUserId).toBe(recipient.id);
  });

  it("rejects acceptance from a different email", async () => {
    const { buyer, ticketId } = await soldTicket();
    const email = uniqueEmail();
    await createTransfer(buyer.id, ticketId, email);
    const token = await rawTokenFor(email);

    const wrongPerson = await createTestUser();
    const result = await acceptTransfer(token, wrongPerson.id, wrongPerson.email);
    expect(result.ok).toBe(false);
  });

  it("rejects an already-accepted transfer", async () => {
    const { buyer, ticketId } = await soldTicket();
    const email = uniqueEmail();
    await createTransfer(buyer.id, ticketId, email);
    const token = await rawTokenFor(email);
    const recipient = await createTestUser({ email });

    await acceptTransfer(token, recipient.id, email);
    const second = await acceptTransfer(token, recipient.id, email);
    expect(second.ok).toBe(false);
  });

  it("rejects an expired transfer", async () => {
    const { buyer, ticketId } = await soldTicket();
    const email = uniqueEmail();
    await createTransfer(buyer.id, ticketId, email);
    const token = await rawTokenFor(email);
    await prisma.ticketTransfer.updateMany({ where: { ticketId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const recipient = await createTestUser({ email });
    const result = await acceptTransfer(token, recipient.id, email);
    expect(result.ok).toBe(false);
  });

  it("rejects a cancelled transfer", async () => {
    const { buyer, ticketId } = await soldTicket();
    const email = uniqueEmail();
    await createTransfer(buyer.id, ticketId, email);
    const token = await rawTokenFor(email);
    const transfer = await prisma.ticketTransfer.findFirstOrThrow({ where: { ticketId } });

    await cancelTransfer(buyer.id, transfer.id);
    const recipient = await createTestUser({ email });
    const result = await acceptTransfer(token, recipient.id, email);
    expect(result.ok).toBe(false);
  });
});

describe("cancelTransfer", () => {
  it("cancels a pending transfer only for its own sender", async () => {
    const { buyer, ticketId } = await soldTicket();
    await createTransfer(buyer.id, ticketId, "recipient@example.com");
    const transfer = await prisma.ticketTransfer.findFirstOrThrow({ where: { ticketId } });

    const stranger = await createTestUser();
    const forbidden = await cancelTransfer(stranger.id, transfer.id);
    expect(forbidden.ok).toBe(false);

    const result = await cancelTransfer(buyer.id, transfer.id);
    expect(result.ok).toBe(true);
    const stored = await prisma.ticketTransfer.findUniqueOrThrow({ where: { id: transfer.id } });
    expect(stored.status).toBe("CANCELLED");
  });
});

describe("getTransferByToken", () => {
  it("reports hasAccount correctly for an existing vs new email", async () => {
    const { buyer, ticketId } = await soldTicket();
    const existingUser = await createTestUser();
    await createTransfer(buyer.id, ticketId, existingUser.email);
    const token = await rawTokenFor(existingUser.email.toLowerCase());

    const info = await getTransferByToken(token);
    expect(info?.hasAccount).toBe(true);
    expect(info?.status).toBe("PENDING");
    expect(info?.expired).toBe(false);
  });

  it("returns null for an unknown token", async () => {
    const info = await getTransferByToken("not-a-real-token");
    expect(info).toBeNull();
  });
});
