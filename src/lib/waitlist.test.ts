import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestEvent, createTestUser, createTestOrganization, addMembership } from "@/lib/test-fixtures";
import { handleSellTickets, handleRefundOrder, handleCancelEvent } from "@/lib/sync-handlers";
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
  sendWaitlistClosureNotifications,
  getWaitlistAnalytics,
  isWithinWaitlistCutoff,
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
// exercises the waitlist against. waitlistCutoffHours is forced to 0 (no
// cutoff) here: createTestEvent's own default startsAt (now + 1 day) sits
// right at the schema's default 24h cutoff, so leaving the schema default
// in place would non-deterministically swallow every notify in this file
// depending on how many ms of test setup elapsed first. The cutoff-specific
// tests below set their own startsAt/waitlistCutoffHours explicitly.
async function soldOutEventWithWaitlist(organizationId: string) {
  const event = await createTestEvent(organizationId, [{ priceCents: 100000, quantityTotal: 1 }]);
  await prisma.event.update({ where: { id: event.id }, data: { waitlistEnabled: true, waitlistCutoffHours: 0 } });

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
    await prisma.event.update({ where: { id: event.id }, data: { waitlistEnabled: true, waitlistCutoffHours: 0 } });
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

describe("sendWaitlistClosureNotifications", () => {
  it("sends the closure message to every WAITING entry once the event has ended", async () => {
    const { organizationId } = await newOrganizer();
    const { ticketTypeId, event } = await soldOutEventWithWaitlist(organizationId);
    await prisma.event.update({ where: { id: event.id }, data: { endsAt: new Date(Date.now() - 1000) } });
    const a = await joinWaitlist({ eventId: event.id, ticketTypeId, name: "A", phone: uniquePhone() });
    const b = await joinWaitlist({ eventId: event.id, ticketTypeId, name: "B", phone: uniquePhone() });

    const result = await sendWaitlistClosureNotifications(event.id);

    expect(result.notifiedCount).toBe(2);
    const aAfter = await getWaitlistEntry(a.id);
    const bAfter = await getWaitlistEntry(b.id);
    expect(aAfter?.status).toBe("EXPIRED");
    expect(bAfter?.status).toBe("EXPIRED");
    expect((aAfter as { expiredReason?: string })?.expiredReason).toBe("EVENT_ENDED");

    const logs = await prisma.notificationLog.findMany({ where: { type: "WAITLIST_CLOSURE" } });
    expect(logs.map((l) => l.recipient).sort()).toEqual([a.phone, b.phone].sort());
  });

  it("never sends the closure message twice", async () => {
    const { organizationId } = await newOrganizer();
    const { ticketTypeId, event } = await soldOutEventWithWaitlist(organizationId);
    await prisma.event.update({ where: { id: event.id }, data: { endsAt: new Date(Date.now() - 1000) } });
    await joinWaitlist({ eventId: event.id, ticketTypeId, name: "A", phone: uniquePhone() });

    const first = await sendWaitlistClosureNotifications(event.id);
    expect(first.notifiedCount).toBe(1);

    const second = await sendWaitlistClosureNotifications(event.id);
    expect(second.notifiedCount).toBe(0);
  });

  it("fires immediately when the organiser cancels the event", async () => {
    const { organizationId, ownerId } = await newOrganizer();
    const { ticketTypeId, event } = await soldOutEventWithWaitlist(organizationId);
    const entry = await joinWaitlist({ eventId: event.id, ticketTypeId, name: "Waiting", phone: uniquePhone() });

    const result = await handleCancelEvent(ownerId, organizationId, { eventId: event.id });
    expect(result.ok).toBe(true);

    const after = await getWaitlistEntry(entry.id);
    expect(after?.status).toBe("EXPIRED");

    const logs = await prisma.notificationLog.findMany({ where: { type: "WAITLIST_CLOSURE", recipient: entry.phone } });
    expect(logs).toHaveLength(1);
  });
});

describe("getWaitlistAnalytics", () => {
  // Longer timeout than this file's other tests — this one chains more
  // sequential DB round-trips (3 joins, 2 notifies, a convert, a direct
  // update, an expiry+cascade, then the analytics read itself) than any
  // other test here, so it's the first to feel it when the shared Neon
  // test branch is under the latency this project's vitest.config.ts
  // already documents, independent of whether the assertions are correct.
  it("returns correct counts for totalJoined, offerSent, offerAccepted, offerExpired", async () => {
    const { organizationId } = await newOrganizer();
    const { ticketTypeId, event } = await soldOutEventWithWaitlist(organizationId);
    const a = await joinWaitlist({ eventId: event.id, ticketTypeId, name: "A", phone: uniquePhone() });
    const b = await joinWaitlist({ eventId: event.id, ticketTypeId, name: "B", phone: uniquePhone() });
    await joinWaitlist({ eventId: event.id, ticketTypeId, name: "C", phone: uniquePhone() });

    await notifyNextWaiting(ticketTypeId); // notifies a
    await convertWaitlistEntry(a.id);

    await notifyNextWaiting(ticketTypeId); // notifies b
    await prisma.waitlistEntry.update({
      where: { id: b.id },
      data: { notifiedAt: new Date(Date.now() - (WAITLIST_NOTIFICATION_WINDOW_HOURS * 60 * 60 * 1000 + 60_000)) },
    });
    await expireStaleWaitlistNotifications(); // expires b (TIMEOUT), cascades to notify c

    const analytics = await getWaitlistAnalytics(event.id);
    expect(analytics.totalJoined).toBe(3);
    expect(analytics.offerSent).toBe(3);
    expect(analytics.offerAccepted).toBe(1);
    expect(analytics.offerExpired).toBe(1);
    expect(analytics.currentWaiting).toBe(0);
  }, 120000);

  it("excludes EVENT_ENDED expiries from offerExpired", async () => {
    const { organizationId } = await newOrganizer();
    const { ticketTypeId, event } = await soldOutEventWithWaitlist(organizationId);
    await joinWaitlist({ eventId: event.id, ticketTypeId, name: "A", phone: uniquePhone() });
    await prisma.event.update({ where: { id: event.id }, data: { endsAt: new Date(Date.now() - 1000) } });

    await sendWaitlistClosureNotifications(event.id);

    const analytics = await getWaitlistAnalytics(event.id);
    expect(analytics.offerExpired).toBe(0);
  });

  it("calculates conversion rate as 0 with no offers sent", async () => {
    const { organizationId } = await newOrganizer();
    const { ticketTypeId, event } = await soldOutEventWithWaitlist(organizationId);
    await joinWaitlist({ eventId: event.id, ticketTypeId, name: "A", phone: uniquePhone() });

    const analytics = await getWaitlistAnalytics(event.id);
    expect(analytics.conversionRate).toBe(0);
  });

  it("calculates conversion rate correctly for partial conversion", async () => {
    const { organizationId } = await newOrganizer();
    const { ticketTypeId, event } = await soldOutEventWithWaitlist(organizationId);
    const a = await joinWaitlist({ eventId: event.id, ticketTypeId, name: "A", phone: uniquePhone() });
    await joinWaitlist({ eventId: event.id, ticketTypeId, name: "B", phone: uniquePhone() });

    await notifyNextWaiting(ticketTypeId); // notifies a
    await convertWaitlistEntry(a.id);
    await notifyNextWaiting(ticketTypeId); // notifies b, left NOTIFIED (not converted)

    const analytics = await getWaitlistAnalytics(event.id);
    expect(analytics.conversionRate).toBe(50);
  });

  it("calculates conversion rate as 100 for full conversion", async () => {
    const { organizationId } = await newOrganizer();
    const { ticketTypeId, event } = await soldOutEventWithWaitlist(organizationId);
    const a = await joinWaitlist({ eventId: event.id, ticketTypeId, name: "A", phone: uniquePhone() });

    await notifyNextWaiting(ticketTypeId);
    await convertWaitlistEntry(a.id);

    const analytics = await getWaitlistAnalytics(event.id);
    expect(analytics.conversionRate).toBe(100);
  });

  it("ranks demand by ticket type, highest first", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId, [
      { priceCents: 1000, quantityTotal: 1, quantitySold: 1, name: "General" },
      { priceCents: 2000, quantityTotal: 1, quantitySold: 1, name: "VIP" },
    ]);
    await prisma.event.update({ where: { id: event.id }, data: { waitlistEnabled: true } });
    const [general, vip] = event.ticketTypes;

    await joinWaitlist({ eventId: event.id, ticketTypeId: general.id, name: "A", phone: uniquePhone() });
    await joinWaitlist({ eventId: event.id, ticketTypeId: general.id, name: "B", phone: uniquePhone() });
    await joinWaitlist({ eventId: event.id, ticketTypeId: vip.id, name: "C", phone: uniquePhone() });

    const analytics = await getWaitlistAnalytics(event.id);
    expect(analytics.demandByTicketType).toEqual([
      { ticketTypeName: "General", count: 2 },
      { ticketTypeName: "VIP", count: 1 },
    ]);
  });
});

describe("isWithinWaitlistCutoff", () => {
  it("blocks a notification within the cutoff window", () => {
    const event = { startsAt: new Date(Date.now() + 2 * 3600000), waitlistCutoffHours: 24 };
    expect(isWithinWaitlistCutoff(event)).toBe(true);
  });

  it("allows a notification outside the cutoff window", () => {
    const event = { startsAt: new Date(Date.now() + 48 * 3600000), waitlistCutoffHours: 24 };
    expect(isWithinWaitlistCutoff(event)).toBe(false);
  });

  it("disables the cutoff entirely when waitlistCutoffHours is 0, even after the event has started", () => {
    const event = { startsAt: new Date(Date.now() - 1000), waitlistCutoffHours: 0 };
    expect(isWithinWaitlistCutoff(event)).toBe(false);
  });

  it("skips sending (but keeps the entry WAITING) when notifyNextWaiting hits the cutoff", async () => {
    const { organizationId } = await newOrganizer();
    const { ticketTypeId, event } = await soldOutEventWithWaitlist(organizationId);
    await prisma.event.update({
      where: { id: event.id },
      data: { startsAt: new Date(Date.now() + 2 * 3600000), waitlistCutoffHours: 24 },
    });
    const entry = await joinWaitlist({ eventId: event.id, ticketTypeId, name: "A", phone: uniquePhone() });

    const result = await notifyNextWaiting(ticketTypeId);

    expect(result).toBeNull();
    const after = await getWaitlistEntry(entry.id);
    expect(after?.status).toBe("WAITING");
    const logs = await prisma.notificationLog.findMany({ where: { recipient: entry.phone } });
    expect(logs).toHaveLength(0);
  });
});
