import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestUser, createTestOrganization, addMembership, createTestEvent } from "@/lib/test-fixtures";
import { handleSellTickets } from "@/lib/sync-handlers";
import { getRecommendedEventIdsForBuyer } from "@/lib/recommendations";

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { user, organizationId: organization.id };
}

async function buyTicketForEvent(eventId: string, buyerId: string) {
  const tt = await prisma.ticketType.findFirstOrThrow({ where: { eventId } });
  return handleSellTickets(buyerId, {
    clientId: `rec-${Date.now()}-${Math.random()}`,
    eventId,
    items: [{ ticketTypeId: tt.id, quantity: 1, codes: [`REC-${Date.now()}-${Math.random()}`] }],
  });
}

async function setCategory(eventId: string, category: string) {
  await prisma.event.update({ where: { id: eventId }, data: { category } });
}

// A collision-proof category string, unique to each test run — the shared
// test DB accumulates events from every other test file across the whole
// suite, and createTestEvent's default category is the hardcoded literal
// "Music" (see test-fixtures.ts), so asserting against that shared,
// unbounded pool would make a take:6-limited result flaky/order-dependent.
// Event.category has no DB-level enum constraint (just a UI-presented
// closed set), so a unique string is a legitimate category value.
function uniqueCategory(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("getRecommendedEventIdsForBuyer", () => {
  it("returns no signal for a buyer with no purchase history — never guesses", async () => {
    const buyer = await createTestUser();
    const ids = await getRecommendedEventIdsForBuyer(buyer.id);
    expect(ids).toEqual([]);
  });

  it("recommends a live upcoming event in the same category as a past purchase, excluding a different category", async () => {
    const { organizationId } = await newOrganizer();
    const buyer = await createTestUser();
    const musicCategory = uniqueCategory("Music");
    const sportsCategory = uniqueCategory("Sports");

    const purchasedEvent = await createTestEvent(organizationId);
    await setCategory(purchasedEvent.id, musicCategory);
    await buyTicketForEvent(purchasedEvent.id, buyer.id);

    const musicEvent = await createTestEvent(organizationId);
    await setCategory(musicEvent.id, musicCategory);
    const sportsEvent = await createTestEvent(organizationId);
    await setCategory(sportsEvent.id, sportsCategory);

    const ids = await getRecommendedEventIdsForBuyer(buyer.id);
    expect(ids).toContain(musicEvent.id);
    expect(ids).not.toContain(sportsEvent.id);
  });

  it("excludes an event the buyer already purchased, even if it's in a matching category", async () => {
    const { organizationId } = await newOrganizer();
    const buyer = await createTestUser();
    const musicCategory = uniqueCategory("Music");

    const purchasedEvent = await createTestEvent(organizationId);
    await setCategory(purchasedEvent.id, musicCategory);
    await buyTicketForEvent(purchasedEvent.id, buyer.id);

    const ids = await getRecommendedEventIdsForBuyer(buyer.id);
    expect(ids).not.toContain(purchasedEvent.id);
  });

  it("excludes a cancelled event and a past event even if the category matches", async () => {
    const { organizationId } = await newOrganizer();
    const buyer = await createTestUser();
    const musicCategory = uniqueCategory("Music");

    const purchasedEvent = await createTestEvent(organizationId);
    await setCategory(purchasedEvent.id, musicCategory);
    await buyTicketForEvent(purchasedEvent.id, buyer.id);

    const cancelledEvent = await createTestEvent(organizationId);
    await setCategory(cancelledEvent.id, musicCategory);
    await prisma.event.update({ where: { id: cancelledEvent.id }, data: { status: "CANCELLED" } });

    const pastEvent = await createTestEvent(organizationId);
    await setCategory(pastEvent.id, musicCategory);
    await prisma.event.update({ where: { id: pastEvent.id }, data: { startsAt: new Date(Date.now() - 86400000) } });

    const ids = await getRecommendedEventIdsForBuyer(buyer.id);
    expect(ids).not.toContain(cancelledEvent.id);
    expect(ids).not.toContain(pastEvent.id);
  });
});
