import { describe, expect, it, vi, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestUser, createTestOrganization, addMembership, createTestEvent, createTestVendor, createTestWallet } from "@/lib/test-fixtures";
import { handleSellTickets } from "@/lib/sync-handlers";
import { buildMemoryMessage } from "@/lib/post-event-memory";
import { getEventAttendees, getAttendeeFinishTime, runPostEventMemorySweep } from "@/lib/post-event-memory-data";
import { formatCents } from "@/lib/format";
import * as notifications from "@/lib/notifications";

// Session — post-event WhatsApp memory recap. Everything DB-backed runs
// against the real test database (see vitest.global-setup.ts); WhatsApp
// goes through the LOGGED fallback (no AT credentials in test), so sends
// are asserted via NotificationLog rows, same convention as
// wallet-transfer.test.ts / pending-topups.test.ts.

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
});

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { user, organizationId: organization.id };
}

// A checked-in attendee (own account + phone) with a paid ticket for the
// given event.
async function checkedInAttendee(eventId: string, ticketTypeId: string, opts: { name?: string; phone?: string | null } = {}) {
  const buyer = await createTestUser({ name: opts.name ?? "Amina Juma" });
  if (opts.phone !== null) {
    await prisma.user.update({ where: { id: buyer.id }, data: { phone: opts.phone ?? `+2557${String(Date.now() % 10_000_000).padStart(7, "0")}${++seq}` } });
  }
  const sale = await handleSellTickets(buyer.id, {
    clientId: uid("order"),
    eventId,
    items: [{ ticketTypeId, quantity: 1, codes: [uid("code")] }],
  });
  const ticket = await prisma.ticket.update({
    where: { id: sale.order!.tickets[0].id },
    data: { checkedIn: true, checkedInAt: new Date() },
  });
  const buyerWithPhone = await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } });
  return { buyer: buyerWithPhone, ticket };
}

async function chargeWallet(walletId: string, vendorId: string, amountCents: number) {
  await prisma.walletTransaction.create({
    data: { type: "SALE", status: "COMPLETED", amountCents, currency: "TZS", walletId, vendorId },
  });
}

describe("buildMemoryMessage", () => {
  const base = { attendee: { name: "Asha Kimaro" }, event: { title: "Kilimanjaro Marathon 2027" } };

  it("includes every line when all data is present", () => {
    const message = buildMemoryMessage({
      ...base,
      checkInTime: new Date("2027-06-01T06:47:00Z"),
      finishTime: "4h 22m 14s",
      totalSpentCents: 1_850_000,
      vendorCount: 3,
      currency: "TZS",
    });
    expect(message).toContain("Hi Asha! 🎉");
    expect(message).toContain("Here's your Kilimanjaro Marathon 2027 recap:");
    expect(message).toMatch(/✅ You checked in at \d\d:\d\d/);
    expect(message).toContain("🏃 You finished in 4h 22m 14s");
    expect(message).toContain(`💳 You spent ${formatCents(1_850_000, "TZS")} at 3 vendors`);
    expect(message).toContain("🌍 chaap.africa");
    expect(message).toContain("Thank you for being part of Kilimanjaro Marathon 2027.");
    expect(message).toContain("See you next time! — The Chaap team");
  });

  it("omits the finish-time line for a non-MARATHON attendee (finishTime not provided)", () => {
    const message = buildMemoryMessage({ ...base, checkInTime: new Date(), finishTime: null });
    expect(message).not.toContain("🏃");
  });

  it("omits the spend line entirely for a zero-spend attendee, never showing TZS 0", () => {
    const message = buildMemoryMessage({ ...base, totalSpentCents: 0, vendorCount: 0 });
    expect(message).not.toContain("💳");
    expect(message).not.toContain("0 vendors");
  });

  it("omits the check-in line entirely when there's no check-in time", () => {
    const message = buildMemoryMessage({ ...base, checkInTime: null });
    expect(message).not.toContain("✅");
  });

  it("uses singular 'vendor' for a single-vendor spend", () => {
    const message = buildMemoryMessage({ ...base, totalSpentCents: 500000, vendorCount: 1 });
    expect(message).toContain("at 1 vendor");
    expect(message).not.toContain("at 1 vendors");
  });

  it("returns Swahili strings for locale 'sw'", () => {
    const message = buildMemoryMessage({ ...base, checkInTime: new Date(), locale: "sw" });
    expect(message).toContain("Habari Asha! 🎉");
    expect(message).toContain("Asante kwa kuwa sehemu ya Kilimanjaro Marathon 2027.");
    expect(message).not.toContain("Hi Asha!");
  });

  it("defaults to English when locale is unspecified", () => {
    const message = buildMemoryMessage(base);
    expect(message).toContain("Hi Asha! 🎉");
  });
});

describe("getEventAttendees / runPostEventMemorySweep", () => {
  it("includes a MARATHON attendee's finish time, formatted Xh Ym Zs", async () => {
    const { organizationId, user: owner } = await newOrganizer();
    const event = await createTestEvent(organizationId, [{ priceCents: 500_000, quantityTotal: 50 }]);
    await prisma.event.update({ where: { id: event.id }, data: { eventType: "MARATHON", gunStartAt: new Date(Date.now() - 5 * 3600_000) } });

    const { buyer, ticket } = await checkedInAttendee(event.id, event.ticketTypes[0].id, { name: "Asha Kimaro" });
    const credential = await prisma.credential.create({
      data: { organizationId, ticketId: ticket.id, code: ticket.code, status: "ACTIVE", createdByUserId: owner.id, createdByName: owner.name },
    });
    const finish = await prisma.timingPoint.create({
      data: { eventId: event.id, clientId: uid("tp"), name: "Finish", sequenceOrder: 1, isStart: false, isFinish: true },
    });
    // 4h22m14s = 15734s
    await prisma.chipTime.create({
      data: { eventId: event.id, recordedAt: new Date(), gunTimeOffsetSeconds: 15734, credentialId: credential.id, timingPointId: finish.id },
    });

    const finishTime = await getAttendeeFinishTime(credential.id, event.id);
    expect(finishTime).toBe("4h 22m 14s");

    const result = await runPostEventMemorySweep(event.id);
    expect(result.notifiedCount).toBe(1);

    const log = await prisma.notificationLog.findFirstOrThrow({ where: { type: "POST_EVENT_MEMORY", recipient: buyer.phone! } });
    expect(log.body).toContain("4h 22m 14s");
  });

  it("never includes a finish time for a non-MARATHON event", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId, [{ priceCents: 200_000, quantityTotal: 50 }]);
    const { buyer } = await checkedInAttendee(event.id, event.ticketTypes[0].id);

    await runPostEventMemorySweep(event.id);

    const log = await prisma.notificationLog.findFirstOrThrow({ where: { type: "POST_EVENT_MEMORY", recipient: buyer.phone! } });
    expect(log.body).not.toContain("🏃");
  });

  it("skips an attendee with no phone number on file, sending nothing for them", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId, [{ priceCents: 200_000, quantityTotal: 50 }]);
    await checkedInAttendee(event.id, event.ticketTypes[0].id, { phone: null });

    const result = await runPostEventMemorySweep(event.id);
    expect(result.notifiedCount).toBe(0);
    expect(result.skippedCount).toBe(1);
  });

  it("is idempotent — an already-notified attendee is skipped on a second sweep", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId, [{ priceCents: 200_000, quantityTotal: 50 }]);
    const { buyer } = await checkedInAttendee(event.id, event.ticketTypes[0].id);

    const first = await runPostEventMemorySweep(event.id);
    expect(first.notifiedCount).toBe(1);

    const second = await runPostEventMemorySweep(event.id);
    expect(second.notifiedCount).toBe(0);
    expect(second.skippedCount).toBe(1);

    const count = await prisma.notificationLog.count({ where: { type: "POST_EVENT_MEMORY", recipient: buyer.phone! } });
    expect(count).toBe(1);
  });

  it("a single send failure does not stop the rest of the sweep", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId, [{ priceCents: 200_000, quantityTotal: 50 }]);
    await checkedInAttendee(event.id, event.ticketTypes[0].id, { name: "First Attendee" });
    await checkedInAttendee(event.id, event.ticketTypes[0].id, { name: "Second Attendee" });

    const spy = vi.spyOn(notifications, "sendNotification").mockRejectedValueOnce(new Error("simulated send failure"));

    const result = await runPostEventMemorySweep(event.id);
    expect(result.notifiedCount).toBe(1);
    expect(result.skippedCount).toBe(1);

    spy.mockRestore();
  });

  it("scopes the sweep to only the given event's attendees", async () => {
    const { organizationId } = await newOrganizer();
    const eventA = await createTestEvent(organizationId, [{ priceCents: 200_000, quantityTotal: 50 }]);
    const eventB = await createTestEvent(organizationId, [{ priceCents: 200_000, quantityTotal: 50 }]);
    const { buyer: buyerA } = await checkedInAttendee(eventA.id, eventA.ticketTypes[0].id, { name: "Event A Attendee" });
    const { buyer: buyerB } = await checkedInAttendee(eventB.id, eventB.ticketTypes[0].id, { name: "Event B Attendee" });

    await runPostEventMemorySweep(eventA.id);

    const loggedForA = await prisma.notificationLog.findFirst({ where: { type: "POST_EVENT_MEMORY", recipient: buyerA.phone! } });
    const loggedForB = await prisma.notificationLog.findFirst({ where: { type: "POST_EVENT_MEMORY", recipient: buyerB.phone! } });
    expect(loggedForA).not.toBeNull();
    expect(loggedForB).toBeNull();
  });

  it("sums cashless spend and counts distinct vendors, omitting the line when spend is zero", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId, [{ priceCents: 200_000, quantityTotal: 50 }]);
    const vendorOne = await createTestVendor(event.id);
    const vendorTwo = await createTestVendor(event.id);
    const { buyer } = await checkedInAttendee(event.id, event.ticketTypes[0].id, { name: "Big Spender" });
    const wallet = await createTestWallet(event.id, buyer.id, { balanceCents: 1_500_000 });
    await chargeWallet(wallet.id, vendorOne.id, 1_000_000);
    await chargeWallet(wallet.id, vendorTwo.id, 500_000);

    const attendees = await getEventAttendees(event.id);
    const attendee = attendees.find((a) => a.userId === buyer.id)!;
    expect(attendee.totalSpentCents).toBe(1_500_000);
    expect(attendee.vendorCount).toBe(2);

    await runPostEventMemorySweep(event.id);
    const log = await prisma.notificationLog.findFirstOrThrow({ where: { type: "POST_EVENT_MEMORY", recipient: buyer.phone! } });
    expect(log.body).toContain("at 2 vendors");
  });
});
