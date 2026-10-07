import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestEvent, createTestUser, createTestOrganization, addMembership, createTestWallet } from "@/lib/test-fixtures";
import { handleSellTickets } from "@/lib/sync-handlers";
import { runWalletTopupReminderSweep } from "@/lib/wallet-topup-reminder";

// Same "anchor to a far-future now unique to this file" discipline as
// reminders.test.ts (see its own header comment) — createTestEvent's
// default startsAt is real-wall-clock "+24h", and NotificationLog/Event
// rows are never cleaned up across the shared test suite, so a sweep
// anchored to the real clock here would also pick up every other test
// file's own "+24h" events. Picked well clear of reminders.test.ts's own
// FAR_FUTURE_NOW (5000 days) so the two files' windows never overlap.
const FAR_FUTURE_NOW = new Date(Date.now() + 8000 * 24 * 60 * 60 * 1000);

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { organizationId: organization.id };
}

async function eventStartingIn(organizationId: string, hoursFromNow: number) {
  const event = await createTestEvent(organizationId, [{ priceCents: 50000, quantityTotal: 10 }]);
  return prisma.event.update({
    where: { id: event.id },
    data: { startsAt: new Date(FAR_FUTURE_NOW.getTime() + hoursFromNow * 60 * 60 * 1000) },
    include: { ticketTypes: true },
  });
}

// A phone unique per call, not a shared literal: NotificationLog has no
// orderId/eventId column, so a query scoped by `recipient` alone would also
// match a row left behind by a retry of this same test, or by an earlier
// run of this suite against this same persistent test database.
let phoneCounter = 0;
function uniquePhone(): string {
  phoneCounter += 1;
  return `073${String(3_000_000 + phoneCounter).padStart(7, "0")}`;
}

async function buyerWithPhone(): Promise<{ id: string; phone: string }> {
  const buyer = await createTestUser();
  const phone = uniquePhone();
  await prisma.user.update({ where: { id: buyer.id }, data: { phone } });
  return { id: buyer.id, phone };
}

async function buyTicket(eventId: string, ticketTypeId: string, buyerId: string) {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const result = await handleSellTickets(buyerId, {
    clientId: `wallet-reminder-order-${unique}`,
    eventId,
    items: [{ ticketTypeId, quantity: 1, codes: [`WR-${unique}`] }],
  });
  if (!result.ok) throw new Error(`test setup: handleSellTickets failed — ${JSON.stringify(result)}`);
  return result;
}

describe("runWalletTopupReminderSweep", () => {
  it("sends a reminder to a ticket holder with no wallet yet, for an event ~30 hours away", async () => {
    const { organizationId } = await newOrganizer();
    const event = await eventStartingIn(organizationId, 30);
    const buyer = await buyerWithPhone();
    await buyTicket(event.id, event.ticketTypes[0].id, buyer.id);

    await runWalletTopupReminderSweep(FAR_FUTURE_NOW);

    const logs = await prisma.notificationLog.findMany({ where: { type: "WALLET_TOPUP_REMINDER", recipient: buyer.phone } });
    expect(logs).toHaveLength(1);
    expect(logs[0].body).toContain(event.title);
  });

  it("does not remind a ticket holder whose wallet already has a positive balance", async () => {
    const { organizationId } = await newOrganizer();
    const event = await eventStartingIn(organizationId, 30);
    const buyer = await buyerWithPhone();
    await buyTicket(event.id, event.ticketTypes[0].id, buyer.id);
    await createTestWallet(event.id, buyer.id, { balanceCents: 500000 });

    await runWalletTopupReminderSweep(FAR_FUTURE_NOW);

    expect(
      await prisma.notificationLog.count({ where: { type: "WALLET_TOPUP_REMINDER", recipient: buyer.phone } })
    ).toBe(0);
  });

  it("still reminds a ticket holder whose wallet exists but has a zero balance", async () => {
    const { organizationId } = await newOrganizer();
    const event = await eventStartingIn(organizationId, 30);
    const buyer = await buyerWithPhone();
    await buyTicket(event.id, event.ticketTypes[0].id, buyer.id);
    await createTestWallet(event.id, buyer.id, { balanceCents: 0 });

    await runWalletTopupReminderSweep(FAR_FUTURE_NOW);

    expect(
      await prisma.notificationLog.count({ where: { type: "WALLET_TOPUP_REMINDER", recipient: buyer.phone } })
    ).toBe(1);
  });

  it("does not send the same reminder twice", async () => {
    const { organizationId } = await newOrganizer();
    const event = await eventStartingIn(organizationId, 30);
    const buyer = await buyerWithPhone();
    await buyTicket(event.id, event.ticketTypes[0].id, buyer.id);

    await runWalletTopupReminderSweep(FAR_FUTURE_NOW);
    await runWalletTopupReminderSweep(FAR_FUTURE_NOW);

    expect(
      await prisma.notificationLog.count({ where: { type: "WALLET_TOPUP_REMINDER", recipient: buyer.phone } })
    ).toBe(1);
  });

  it("ignores an event outside the 24-48h window", async () => {
    const { organizationId } = await newOrganizer();
    const event = await eventStartingIn(organizationId, 72);
    const buyer = await buyerWithPhone();
    await buyTicket(event.id, event.ticketTypes[0].id, buyer.id);

    await runWalletTopupReminderSweep(FAR_FUTURE_NOW);

    expect(
      await prisma.notificationLog.count({ where: { type: "WALLET_TOPUP_REMINDER", recipient: buyer.phone } })
    ).toBe(0);
  });
});
