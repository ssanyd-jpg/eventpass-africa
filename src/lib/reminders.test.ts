import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestEvent, createTestUser, createTestOrganization, addMembership } from "@/lib/test-fixtures";
import { handleSellTickets } from "@/lib/sync-handlers";
import { sendEventReminders } from "@/lib/reminders";

// This test file's own fixed "now" — always thousands of days ahead of the
// real clock. createTestEvent's default startsAt is real-wall-clock "+24h",
// and this NotificationLog/Event data is never cleaned up across the whole
// (very large) shared test suite, so calling sendEventReminders() with the
// *real* current time here would also match every other test file's own
// "+24h" events created minutes earlier or later in the same run — up to
// hundreds of extra Order/NotificationLog round-trips per call, which is
// what made this file time out before this fix. Anchoring everything to a
// far-future "now" that only this file's own events ever target keeps the
// startsAt query narrow (and the suite fast) regardless of how large the
// shared tables grow.
const FAR_FUTURE_NOW = new Date(Date.now() + 5000 * 24 * 60 * 60 * 1000);

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { organizationId: organization.id };
}

// createTestEvent has no startsAt override, so every event here is created
// then moved to a precise offset from FAR_FUTURE_NOW.
async function eventStartingIn(organizationId: string, hoursFromNow: number) {
  const event = await createTestEvent(organizationId);
  return prisma.event.update({
    where: { id: event.id },
    data: { startsAt: new Date(FAR_FUTURE_NOW.getTime() + hoursFromNow * 60 * 60 * 1000) },
    include: { ticketTypes: true },
  });
}

// Sells one ticket to `buyerId` on `eventId` — same handleSellTickets path
// every other integration test in this suite uses, so a reminder is
// exercised against a real PAID order, not a hand-inserted row.
async function buyTicket(eventId: string, ticketTypeId: string, buyerId: string) {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const result = await handleSellTickets(buyerId, {
    clientId: `reminder-order-${unique}`,
    eventId,
    items: [{ ticketTypeId, quantity: 1, codes: [`CODE-${unique}`] }],
  });
  if (!result.ok) throw new Error(`test setup: handleSellTickets failed — ${JSON.stringify(result)}`);
  return result;
}

async function buyerWithPhone(phone: string) {
  const buyer = await createTestUser();
  return prisma.user.update({ where: { id: buyer.id }, data: { phone } });
}

describe("sendEventReminders", () => {
  it("sends a reminder to a ticket holder with a phone, for an event ~24 hours away", async () => {
    const { organizationId } = await newOrganizer();
    const event = await eventStartingIn(organizationId, 24);
    const buyer = await buyerWithPhone("0712000101");
    await buyTicket(event.id, event.ticketTypes[0].id, buyer.id);

    await sendEventReminders(FAR_FUTURE_NOW);

    const logs = await prisma.notificationLog.findMany({ where: { type: "EVENT_REMINDER", recipient: "0712000101" } });
    expect(logs).toHaveLength(1);
    expect(logs[0].body).toContain(event.title);
    expect(logs[0].body).toContain("tomorrow");
  });

  it("does not notify for an event more than 44 hours away", async () => {
    const { organizationId } = await newOrganizer();
    const event = await eventStartingIn(organizationId, 72);
    const buyer = await buyerWithPhone("0712000102");
    await buyTicket(event.id, event.ticketTypes[0].id, buyer.id);

    await sendEventReminders(FAR_FUTURE_NOW);

    const logs = await prisma.notificationLog.findMany({ where: { type: "EVENT_REMINDER", recipient: "0712000102" } });
    expect(logs).toHaveLength(0);
  });

  it("does not notify for an event that already started", async () => {
    const { organizationId } = await newOrganizer();
    const event = await eventStartingIn(organizationId, -1);
    const buyer = await buyerWithPhone("0712000103");
    await buyTicket(event.id, event.ticketTypes[0].id, buyer.id);

    await sendEventReminders(FAR_FUTURE_NOW);

    const logs = await prisma.notificationLog.findMany({ where: { type: "EVENT_REMINDER", recipient: "0712000103" } });
    expect(logs).toHaveLength(0);
  });

  it("does not send a duplicate reminder to the same attendee on a second run", async () => {
    const { organizationId } = await newOrganizer();
    const event = await eventStartingIn(organizationId, 24);
    const buyer = await buyerWithPhone("0712000104");
    await buyTicket(event.id, event.ticketTypes[0].id, buyer.id);

    await sendEventReminders(FAR_FUTURE_NOW);
    await sendEventReminders(FAR_FUTURE_NOW);

    const logs = await prisma.notificationLog.findMany({ where: { type: "EVENT_REMINDER", recipient: "0712000104" } });
    expect(logs).toHaveLength(1);
  });

  it.each([
    { hours: 20.5, reminded: true },
    { hours: 27.5, reminded: true },
    { hours: 43.5, reminded: true },
    { hours: 19, reminded: false },
    { hours: 45, reminded: false },
  ])("reminds only inside the 20–44h window ($hours h away → reminded: $reminded)", async ({ hours, reminded }) => {
    const { organizationId } = await newOrganizer();
    const event = await eventStartingIn(organizationId, hours);
    const phone = `07120${Math.floor(hours * 10)}`;
    const buyer = await buyerWithPhone(phone);
    await buyTicket(event.id, event.ticketTypes[0].id, buyer.id);

    await sendEventReminders(FAR_FUTURE_NOW);

    const logs = await prisma.notificationLog.findMany({ where: { type: "EVENT_REMINDER", recipient: phone } });
    expect(logs).toHaveLength(reminded ? 1 : 0);
  });

  it("stamps reminderSentAt on the buyer's tickets once the reminder is sent", async () => {
    const { organizationId } = await newOrganizer();
    const event = await eventStartingIn(organizationId, 24);
    const buyer = await buyerWithPhone("0712000110");
    await buyTicket(event.id, event.ticketTypes[0].id, buyer.id);
    await buyTicket(event.id, event.ticketTypes[0].id, buyer.id); // a second order, same buyer

    const before = await prisma.ticket.findMany({ where: { eventId: event.id } });
    expect(before).toHaveLength(2);
    expect(before.every((t) => t.reminderSentAt === null)).toBe(true);

    await sendEventReminders(FAR_FUTURE_NOW);

    const after = await prisma.ticket.findMany({ where: { eventId: event.id } });
    expect(after.every((t) => t.reminderSentAt !== null)).toBe(true);
    // One buyer → one reminder, not one per ticket or order.
    const logs = await prisma.notificationLog.findMany({ where: { type: "EVENT_REMINDER", recipient: "0712000110" } });
    expect(logs).toHaveLength(1);
  });

  it("skips tickets whose reminderSentAt is already set, even with no NotificationLog row", async () => {
    const { organizationId } = await newOrganizer();
    const event = await eventStartingIn(organizationId, 24);
    const buyer = await buyerWithPhone("0712000111");
    await buyTicket(event.id, event.ticketTypes[0].id, buyer.id);
    await prisma.ticket.updateMany({ where: { eventId: event.id }, data: { reminderSentAt: new Date() } });

    await sendEventReminders(FAR_FUTURE_NOW);

    const logs = await prisma.notificationLog.findMany({ where: { type: "EVENT_REMINDER", recipient: "0712000111" } });
    expect(logs).toHaveLength(0);
  });

  it("backfills reminderSentAt for a buyer reminded before the column existed", async () => {
    const { organizationId } = await newOrganizer();
    const event = await eventStartingIn(organizationId, 24);
    const buyer = await buyerWithPhone("0712000112");
    await buyTicket(event.id, event.ticketTypes[0].id, buyer.id);
    const loggedAt = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.notificationLog.create({
      data: {
        type: "EVENT_REMINDER",
        channel: "WHATSAPP",
        recipient: "0712000112",
        subject: `Event reminder — ${event.id}`,
        body: "legacy reminder",
        status: "SENT",
        createdAt: loggedAt,
      },
    });

    await sendEventReminders(FAR_FUTURE_NOW);

    const logs = await prisma.notificationLog.findMany({ where: { type: "EVENT_REMINDER", recipient: "0712000112" } });
    expect(logs).toHaveLength(1); // no second reminder
    const tickets = await prisma.ticket.findMany({ where: { eventId: event.id } });
    expect(tickets[0].reminderSentAt?.getTime()).toBe(loggedAt.getTime());
  });

  it("skips a ticket holder with no phone on file", async () => {
    const { organizationId } = await newOrganizer();
    const event = await eventStartingIn(organizationId, 24);
    const buyer = await createTestUser(); // no phone set
    await buyTicket(event.id, event.ticketTypes[0].id, buyer.id);

    const before = await prisma.notificationLog.count({ where: { type: "EVENT_REMINDER" } });
    await sendEventReminders(FAR_FUTURE_NOW);
    const after = await prisma.notificationLog.count({ where: { type: "EVENT_REMINDER" } });

    // Delta rather than an absolute count: this specific call also
    // (harmlessly) reprocesses the still-eligible, already-reminded events
    // from the earlier tests in this file, which never adds new rows —
    // idempotency is covered directly above. Safe as a before/after delta
    // because the suite runs single-threaded (fileParallelism: false).
    expect(after).toBe(before);
  });
});
