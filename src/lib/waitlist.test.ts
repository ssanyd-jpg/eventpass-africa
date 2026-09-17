import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestEvent, createTestUser, createTestOrganization, addMembership } from "@/lib/test-fixtures";
import { handleSellTickets, handleRefundOrder } from "@/lib/sync-handlers";
import {
  joinWaitlist,
  leaveWaitlist,
  getWaitlistEntry,
  getWaitlistCounts,
  notifyNextWaiting,
  notifyNextInWaitlist,
  releaseWaitlistCapacity,
  convertWaitlistEntry,
  expireStaleWaitlistNotifications,
  WAITLIST_NOTIFICATION_WINDOW_HOURS,
} from "@/lib/waitlist";

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { organizationId: organization.id, ownerId: user.id };
}

// One ticket type, sold out from the start (quantityTotal 1, one PAID sale),
// on an event with waitlistEnabled true — the state every test in this file
// exercises the waitlist against.
async function soldOutEventWithWaitlist(organizationId: string) {
  const event = await createTestEvent(organizationId, [{ priceCents: 100000, quantityTotal: 1 }]);
  await prisma.event.update({ where: { id: event.id }, data: { waitlistEnabled: true } });

  const buyer = await createTestUser();
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const result = await handleSellTickets(buyer.id, {
    clientId: `waitlist-order-${unique}`,
    eventId: event.id,
    items: [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1, codes: [`CODE-${unique}`] }],
  });
  if (!result.ok || !result.order) throw new Error(`test setup: handleSellTickets failed — ${JSON.stringify(result)}`);

  return { event, ticketTypeId: event.ticketTypes[0].id, orderId: result.order.id };
}

function uniquePhone() {
  return `07${Math.floor(10000000 + Math.random() * 89999999)}`;
}

describe("joinWaitlist", () => {
  it("creates an entry at position 1 for the first joiner", async () => {
    const { organizationId } = await newOrganizer();
    const { ticketTypeId, event } = await soldOutEventWithWaitlist(organizationId);

    const entry = await joinWaitlist({
      eventId: event.id,
      ticketTypeId,
      name: "Amina",
      phone: uniquePhone(),
    });

    expect(entry.position).toBe(1);
    expect(entry.status).toBe("WAITING");
  });

  it("increments position correctly as more people join the same ticket type", async () => {
    const { organizationId } = await newOrganizer();
    const { ticketTypeId, event } = await soldOutEventWithWaitlist(organizationId);

    const first = await joinWaitlist({ eventId: event.id, ticketTypeId, name: "A", phone: uniquePhone() });
    const second = await joinWaitlist({ eventId: event.id, ticketTypeId, name: "B", phone: uniquePhone() });
    const third = await joinWaitlist({ eventId: event.id, ticketTypeId, name: "C", phone: uniquePhone() });

    expect([first.position, second.position, third.position]).toEqual([1, 2, 3]);
  });

  it("keeps separate position sequences per ticket type", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId, [
      { priceCents: 1000, quantityTotal: 1, quantitySold: 1 },
      { priceCents: 2000, quantityTotal: 1, quantitySold: 1 },
    ]);
    await prisma.event.update({ where: { id: event.id }, data: { waitlistEnabled: true } });
    const [tierA, tierB] = event.ticketTypes;

    const a1 = await joinWaitlist({ eventId: event.id, ticketTypeId: tierA.id, name: "A1", phone: uniquePhone() });
    const b1 = await joinWaitlist({ eventId: event.id, ticketTypeId: tierB.id, name: "B1", phone: uniquePhone() });
    const a2 = await joinWaitlist({ eventId: event.id, ticketTypeId: tierA.id, name: "A2", phone: uniquePhone() });

    expect(a1.position).toBe(1);
    expect(b1.position).toBe(1);
    expect(a2.position).toBe(2);
  });

  it("supports a guest entry with no userId", async () => {
    const { organizationId } = await newOrganizer();
    const { ticketTypeId, event } = await soldOutEventWithWaitlist(organizationId);

    const entry = await joinWaitlist({
      eventId: event.id,
      ticketTypeId,
      name: "Guest Attendee",
      phone: uniquePhone(),
      email: "guest@example.com",
    });

    expect(entry.userId).toBeNull();
    const fetched = await getWaitlistEntry(entry.id);
    expect(fetched?.name).toBe("Guest Attendee");
    expect(fetched?.event.slug).toBe(event.slug);
  });

  it("normalizes the phone number to E.164 the same way SMS/WhatsApp sends do", async () => {
    const { organizationId } = await newOrganizer();
    const { ticketTypeId, event } = await soldOutEventWithWaitlist(organizationId);

    const entry = await joinWaitlist({ eventId: event.id, ticketTypeId, name: "A", phone: "0712345678" });

    expect(entry.phone).toBe("+255712345678");
  });
});

describe("notifyNextWaiting", () => {
  it("notifies the lowest-position WAITING entry and logs the WhatsApp send", async () => {
    const { organizationId } = await newOrganizer();
    const { ticketTypeId, event } = await soldOutEventWithWaitlist(organizationId);

    const first = await joinWaitlist({ eventId: event.id, ticketTypeId, name: "First", phone: uniquePhone() });
    const second = await joinWaitlist({ eventId: event.id, ticketTypeId, name: "Second", phone: uniquePhone() });

    const notified = await notifyNextWaiting(ticketTypeId);

    expect(notified?.id).toBe(first.id);
    expect(notified?.status).toBe("NOTIFIED");
    expect(notified?.notifiedAt).not.toBeNull();

    const stillWaiting = await getWaitlistEntry(second.id);
    expect(stillWaiting?.status).toBe("WAITING");

    const logs = await prisma.notificationLog.findMany({
      where: { type: "WAITLIST_SPOT_AVAILABLE", recipient: first.phone },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].body).toContain(event.title);
    expect(logs[0].body).toContain("2 hours");
  });

  it("returns null when nobody is waiting", async () => {
    const { organizationId } = await newOrganizer();
    const { ticketTypeId } = await soldOutEventWithWaitlist(organizationId);

    const notified = await notifyNextWaiting(ticketTypeId);
    expect(notified).toBeNull();
  });
});

describe("notifyNextInWaitlist / releaseWaitlistCapacity", () => {
  it("notifies up to `count` next entries in queue order", async () => {
    const { organizationId } = await newOrganizer();
    const { ticketTypeId, event } = await soldOutEventWithWaitlist(organizationId);
    const first = await joinWaitlist({ eventId: event.id, ticketTypeId, name: "A", phone: uniquePhone() });
    const second = await joinWaitlist({ eventId: event.id, ticketTypeId, name: "B", phone: uniquePhone() });
    await joinWaitlist({ eventId: event.id, ticketTypeId, name: "C", phone: uniquePhone() });

    const notified = await notifyNextInWaitlist(ticketTypeId, 2);

    expect(notified.map((e) => e.id)).toEqual([first.id, second.id]);
  });

  it("does nothing when the event has not opted into the waitlist", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId, [{ priceCents: 1000, quantityTotal: 1, quantitySold: 1 }]);
    // waitlistEnabled left at its default (false).
    const tt = event.ticketTypes[0];
    await joinWaitlist({ eventId: event.id, ticketTypeId: tt.id, name: "A", phone: uniquePhone() });

    const notified = await releaseWaitlistCapacity(tt.id, 1);

    expect(notified).toHaveLength(0);
  });
});

describe("a cancelled/refunded order triggers the waitlist", () => {
  it("notifies the next waitlist entry once handleRefundOrder frees the ticket type's capacity", async () => {
    const { organizationId, ownerId } = await newOrganizer();
    const { ticketTypeId, event, orderId } = await soldOutEventWithWaitlist(organizationId);
    const waiting = await joinWaitlist({ eventId: event.id, ticketTypeId, name: "Waiting Person", phone: uniquePhone() });

    const result = await handleRefundOrder(ownerId, organizationId, { orderId });
    expect(result.ok).toBe(true);

    const entryAfter = await getWaitlistEntry(waiting.id);
    expect(entryAfter?.status).toBe("NOTIFIED");

    const logs = await prisma.notificationLog.findMany({
      where: { type: "WAITLIST_SPOT_AVAILABLE", recipient: waiting.phone },
    });
    expect(logs).toHaveLength(1);
  });
});

describe("expireStaleWaitlistNotifications", () => {
  it("expires a NOTIFIED entry past the 2-hour window and cascades to the next WAITING entry", async () => {
    const { organizationId } = await newOrganizer();
    const { ticketTypeId, event } = await soldOutEventWithWaitlist(organizationId);
    const first = await joinWaitlist({ eventId: event.id, ticketTypeId, name: "First", phone: uniquePhone() });
    const second = await joinWaitlist({ eventId: event.id, ticketTypeId, name: "Second", phone: uniquePhone() });

    await notifyNextWaiting(ticketTypeId); // notifies `first`
    // Backdate notifiedAt past the window, as if 2+ hours had really passed.
    const overdueAt = new Date(Date.now() - (WAITLIST_NOTIFICATION_WINDOW_HOURS * 60 * 60 * 1000 + 60_000));
    await prisma.waitlistEntry.update({ where: { id: first.id }, data: { notifiedAt: overdueAt } });

    const result = await expireStaleWaitlistNotifications();

    expect(result.expired).toBe(1);
    expect(result.notifiedNext).toBe(1);

    const firstAfter = await getWaitlistEntry(first.id);
    expect(firstAfter?.status).toBe("EXPIRED");
    const secondAfter = await getWaitlistEntry(second.id);
    expect(secondAfter?.status).toBe("NOTIFIED");
  });

  it("leaves a NOTIFIED entry alone while still inside its 2-hour window", async () => {
    const { organizationId } = await newOrganizer();
    const { ticketTypeId, event } = await soldOutEventWithWaitlist(organizationId);
    const entry = await joinWaitlist({ eventId: event.id, ticketTypeId, name: "Recent", phone: uniquePhone() });
    await notifyNextWaiting(ticketTypeId);

    const result = await expireStaleWaitlistNotifications();

    expect(result.expired).toBe(0);
    const after = await getWaitlistEntry(entry.id);
    expect(after?.status).toBe("NOTIFIED");
  });
});

describe("convertWaitlistEntry", () => {
  it("flips a NOTIFIED entry to CONVERTED", async () => {
    const { organizationId } = await newOrganizer();
    const { ticketTypeId, event } = await soldOutEventWithWaitlist(organizationId);
    const entry = await joinWaitlist({ eventId: event.id, ticketTypeId, name: "Buyer", phone: uniquePhone() });
    await notifyNextWaiting(ticketTypeId);

    const converted = await convertWaitlistEntry(entry.id);

    expect(converted).toBe(true);
    const after = await getWaitlistEntry(entry.id);
    expect(after?.status).toBe("CONVERTED");
  });

  it("does nothing to an entry that is still WAITING", async () => {
    const { organizationId } = await newOrganizer();
    const { ticketTypeId, event } = await soldOutEventWithWaitlist(organizationId);
    const entry = await joinWaitlist({ eventId: event.id, ticketTypeId, name: "Still waiting", phone: uniquePhone() });

    const converted = await convertWaitlistEntry(entry.id);

    expect(converted).toBe(false);
    const after = await getWaitlistEntry(entry.id);
    expect(after?.status).toBe("WAITING");
  });
});

describe("leaveWaitlist", () => {
  it("removes a WAITING entry without notifying anyone else", async () => {
    const { organizationId } = await newOrganizer();
    const { ticketTypeId, event } = await soldOutEventWithWaitlist(organizationId);
    const entry = await joinWaitlist({ eventId: event.id, ticketTypeId, name: "Leaving", phone: uniquePhone() });
    const other = await joinWaitlist({ eventId: event.id, ticketTypeId, name: "Other", phone: uniquePhone() });

    await leaveWaitlist(entry.id);

    expect(await getWaitlistEntry(entry.id)).toBeNull();
    const otherAfter = await getWaitlistEntry(other.id);
    expect(otherAfter?.status).toBe("WAITING");
  });

  it("releases a NOTIFIED entry's spot to the next WAITING entry", async () => {
    const { organizationId } = await newOrganizer();
    const { ticketTypeId, event } = await soldOutEventWithWaitlist(organizationId);
    const first = await joinWaitlist({ eventId: event.id, ticketTypeId, name: "First", phone: uniquePhone() });
    const second = await joinWaitlist({ eventId: event.id, ticketTypeId, name: "Second", phone: uniquePhone() });
    await notifyNextWaiting(ticketTypeId); // notifies `first`

    await leaveWaitlist(first.id);

    const secondAfter = await getWaitlistEntry(second.id);
    expect(secondAfter?.status).toBe("NOTIFIED");
  });
});

describe("getWaitlistCounts", () => {
  it("lets an organiser see the current WAITING count per ticket type", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId, [
      { priceCents: 1000, quantityTotal: 1, quantitySold: 1 },
      { priceCents: 2000, quantityTotal: 1, quantitySold: 1 },
    ]);
    await prisma.event.update({ where: { id: event.id }, data: { waitlistEnabled: true } });
    const [tierA, tierB] = event.ticketTypes;

    await joinWaitlist({ eventId: event.id, ticketTypeId: tierA.id, name: "A1", phone: uniquePhone() });
    await joinWaitlist({ eventId: event.id, ticketTypeId: tierA.id, name: "A2", phone: uniquePhone() });
    const notifiedOne = await joinWaitlist({ eventId: event.id, ticketTypeId: tierB.id, name: "B1", phone: uniquePhone() });
    await notifyNextWaiting(tierB.id); // moves notifiedOne out of WAITING

    const counts = await getWaitlistCounts(event.id);

    const countFor = (id: string) => counts.find((c) => c.ticketTypeId === id)?.waiting;
    expect(countFor(tierA.id)).toBe(2);
    expect(countFor(tierB.id)).toBe(0);
    expect(await getWaitlistEntry(notifiedOne.id).then((e) => e?.status)).toBe("NOTIFIED");
  });
});
