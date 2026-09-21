import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestUser, createTestOrganization, addMembership, createTestEvent } from "@/lib/test-fixtures";
import { handleSellTickets } from "@/lib/sync-handlers";
import { createTransfer } from "@/lib/ticket-transfer";
import {
  RESALE_COMMISSION_RATE,
  LISTING_EXPIRY_MS,
  calculateCommission,
  createListing,
  cancelListing,
  purchaseListing,
  expireStaleListings,
  getActiveListingsForEvent,
  countActiveListings,
  getTicketResaleState,
  getOrganizerResaleListings,
  listingExpiresAt,
  maxListingPrice,
  summarizeResaleRevenue,
  validateAskingPrice,
} from "@/lib/resale";

const FACE_VALUE = 200000; // createTestEvent's default ticket price, minor units

// Real Postgres, no per-test reset, and NotificationLog rows outlive the run —
// every phone used as a recipient must be unique across runs too, or an
// earlier run's messages leak into this run's assertions. Stored already
// normalized (+255…) because that is the form purchaseListing saves on the buyer.
function uniquePhone() {
  return `+2557${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
}

async function userWithPhone() {
  const user = await createTestUser();
  const phone = uniquePhone();
  await prisma.user.update({ where: { id: user.id }, data: { phone } });
  return { user, phone };
}

// A sold, resale-enabled event with one ticket held by `seller`.
async function listableTicket(
  overrides: { resaleEnabled?: boolean; maxResalePrice?: number | null; startsInMs?: number } = {}
) {
  // Independent setup, run concurrently — every call is a Neon round-trip.
  const [organization, seller] = await Promise.all([
    (async () => {
      const organizer = await createTestUser();
      const org = await createTestOrganization();
      await addMembership(org.id, organizer.id, "OWNER");
      return org;
    })(),
    userWithPhone(),
  ]);

  const created = await createTestEvent(organization.id);
  const event = await prisma.event.update({
    where: { id: created.id },
    data: {
      resaleEnabled: overrides.resaleEnabled ?? true,
      maxResalePrice: overrides.maxResalePrice ?? null,
      ...(overrides.startsInMs !== undefined ? { startsAt: new Date(Date.now() + overrides.startsInMs) } : {}),
    },
  });

  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sale = await handleSellTickets(seller.user.id, {
    clientId: `resale-order-${unique}`,
    eventId: event.id,
    items: [{ ticketTypeId: created.ticketTypes[0].id, quantity: 1, codes: [`RS-${unique}`] }],
  });
  if (!sale.ok || !sale.order) throw new Error(`test setup: sale failed — ${JSON.stringify(sale)}`);

  return { event, seller, ticketId: sale.order.tickets[0].id, organizationId: organization.id };
}

describe("resale pricing rules", () => {
  it("takes 5% commission and pays the seller the rest", () => {
    expect(RESALE_COMMISSION_RATE).toBe(0.05);
    expect(calculateCommission(200000)).toEqual({ commissionAmount: 10000, sellerPayoutAmount: 190000 });
    expect(calculateCommission(150000)).toEqual({ commissionAmount: 7500, sellerPayoutAmount: 142500 });
  });

  it("rounds commission to whole minor units and never loses a cent", () => {
    for (const price of [1, 10, 333, 99999, 123457]) {
      const { commissionAmount, sellerPayoutAmount } = calculateCommission(price);
      expect(Number.isInteger(commissionAmount)).toBe(true);
      expect(commissionAmount + sellerPayoutAmount).toBe(price);
    }
    expect(calculateCommission(333).commissionAmount).toBe(17); // 16.65 → 17
  });

  it("caps the price at face value, or the organiser's lower cap", () => {
    expect(maxListingPrice(200000, null)).toBe(200000);
    expect(maxListingPrice(200000, 150000)).toBe(150000);
    // A cap above face value can never raise the ceiling — no markup.
    expect(maxListingPrice(200000, 500000)).toBe(200000);
  });

  it("validates the asking price against the cap", () => {
    expect(validateAskingPrice(200000, 200000, null, "TZS")).toEqual({ ok: true, askingPrice: 200000 });
    expect(validateAskingPrice(100000, 200000, null, "TZS")).toEqual({ ok: true, askingPrice: 100000 });

    const above = validateAskingPrice(200001, 200000, null, "TZS");
    expect(above.ok).toBe(false);
    if (!above.ok) expect(above.error).toContain("face value");

    const aboveCap = validateAskingPrice(160000, 200000, 150000, "TZS");
    expect(aboveCap.ok).toBe(false);
    if (!aboveCap.ok) expect(aboveCap.error).toContain("maximum resale price");

    for (const bad of [0, -5, 1.5, NaN, "100", null, undefined]) {
      expect(validateAskingPrice(bad, 200000, null, "TZS").ok).toBe(false);
    }
  });

  it("expires a listing after 7 days, but never after the event starts", () => {
    const now = new Date("2030-01-01T00:00:00Z");
    const farEvent = new Date("2030-02-01T00:00:00Z");
    const soonEvent = new Date("2030-01-03T00:00:00Z");
    expect(listingExpiresAt(now, farEvent).getTime()).toBe(now.getTime() + LISTING_EXPIRY_MS);
    expect(listingExpiresAt(now, soonEvent).getTime()).toBe(soonEvent.getTime());
  });
});

describe("createListing", { timeout: 180_000 }, () => {
  it("creates an ACTIVE listing at the asking price with the ticket's face value", async () => {
    const { event, seller, ticketId } = await listableTicket({ startsInMs: 30 * 24 * 60 * 60 * 1000 });
    const before = Date.now();

    const result = await createListing(seller.user.id, ticketId, 150000);
    expect(result.ok).toBe(true);

    const listing = await prisma.ticketListing.findUniqueOrThrow({ where: { ticketId } });
    expect(listing.status).toBe("ACTIVE");
    expect(listing.askingPrice).toBe(150000);
    expect(listing.originalPrice).toBe(FACE_VALUE);
    expect(listing.currency).toBe("TZS");
    expect(listing.sellerId).toBe(seller.user.id);
    expect(listing.eventId).toBe(event.id);
    expect(listing.buyerId).toBeNull();
    expect(listing.soldAt).toBeNull();
    expect(listing.commissionAmount).toBe(0);
    // 7 days out, since the event is a month away.
    expect(listing.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + LISTING_EXPIRY_MS - 1000);
    expect(listing.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + LISTING_EXPIRY_MS + 1000);
  });

  it("caps a listing's life at the event start when that's sooner than 7 days", async () => {
    const { event, seller, ticketId } = await listableTicket(); // event starts in 24h
    await createListing(seller.user.id, ticketId, FACE_VALUE);
    const listing = await prisma.ticketListing.findUniqueOrThrow({ where: { ticketId } });
    expect(listing.expiresAt!.getTime()).toBe(event.startsAt.getTime());
  });

  it("sends the seller a WhatsApp confirming the listing", async () => {
    const { seller, ticketId } = await listableTicket();
    await createListing(seller.user.id, ticketId, 180000);

    const logs = await prisma.notificationLog.findMany({ where: { type: "TICKET_RESALE", recipient: seller.phone } });
    expect(logs).toHaveLength(1);
    expect(logs[0].channel).toBe("WHATSAPP");
    expect(logs[0].body).toContain("listed for resale");
    expect(logs[0].body).toContain("5%");
    expect(logs[0].body).toContain(`/account/tickets/${ticketId}`);
  });

  it("lists at exactly face value", async () => {
    const { seller, ticketId } = await listableTicket();
    expect((await createListing(seller.user.id, ticketId, FACE_VALUE)).ok).toBe(true);
  });

  it("lists below face value", async () => {
    const { seller, ticketId } = await listableTicket();
    expect((await createListing(seller.user.id, ticketId, 1)).ok).toBe(true);
  });

  it("refuses a price above face value and creates nothing", async () => {
    const { seller, ticketId } = await listableTicket();
    const result = await createListing(seller.user.id, ticketId, FACE_VALUE + 1);
    expect(result).toMatchObject({ ok: false });
    expect(await prisma.ticketListing.count({ where: { ticketId } })).toBe(0);
  });

  it("enforces the organiser's maximum resale price when it is below face value", async () => {
    const { seller, ticketId } = await listableTicket({ maxResalePrice: 150000 });

    const tooHigh = await createListing(seller.user.id, ticketId, 160000);
    expect(tooHigh.ok).toBe(false);
    if (!tooHigh.ok) expect(tooHigh.error).toContain("maximum resale price");

    expect((await createListing(seller.user.id, ticketId, 150000)).ok).toBe(true);
  });

  it("ignores an organiser cap that is above face value — never a markup", async () => {
    const { seller, ticketId } = await listableTicket({ maxResalePrice: 900000 });
    expect((await createListing(seller.user.id, ticketId, FACE_VALUE + 1)).ok).toBe(false);
    expect((await createListing(seller.user.id, ticketId, FACE_VALUE)).ok).toBe(true);
  });

  it("refuses a ticket that has already been used to check in", async () => {
    const { seller, ticketId } = await listableTicket();
    await prisma.ticket.update({ where: { id: ticketId }, data: { checkedIn: true, checkedInAt: new Date() } });

    const result = await createListing(seller.user.id, ticketId, 100000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("check in");
    expect(await prisma.ticketListing.count({ where: { ticketId } })).toBe(0);
  });

  it("refuses a ticket with checkedInAt set even if the checkedIn flag isn't", async () => {
    const { seller, ticketId } = await listableTicket();
    await prisma.ticket.update({ where: { id: ticketId }, data: { checkedInAt: new Date() } });
    expect((await createListing(seller.user.id, ticketId, 100000)).ok).toBe(false);
  });

  it("refuses a ticket for an event that has already started", async () => {
    const { seller, ticketId } = await listableTicket({ startsInMs: 24 * 60 * 60 * 1000 });
    const result = await createListing(seller.user.id, ticketId, 100000, new Date(Date.now() + 48 * 60 * 60 * 1000));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("already started");
  });

  it("refuses when the organiser hasn't enabled resale", async () => {
    const { seller, ticketId } = await listableTicket({ resaleEnabled: false });
    const result = await createListing(seller.user.id, ticketId, 100000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("isn't enabled");
  });

  it("refuses someone who isn't the ticket's holder", async () => {
    const { ticketId } = await listableTicket();
    const stranger = await createTestUser();
    const result = await createListing(stranger.id, ticketId, 100000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("isn't your ticket");
  });

  it("allows only one listing per ticket at a time", async () => {
    const { seller, ticketId } = await listableTicket();
    expect((await createListing(seller.user.id, ticketId, 100000)).ok).toBe(true);

    const second = await createListing(seller.user.id, ticketId, 90000);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain("already listed");
    expect(await prisma.ticketListing.count({ where: { ticketId } })).toBe(1);
  });

  it("refuses a ticket with a pending transfer", async () => {
    const { seller, ticketId } = await listableTicket();
    await createTransfer(seller.user.id, ticketId, `friend-${Date.now()}@example.com`);
    const result = await createListing(seller.user.id, ticketId, 100000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("pending transfer");
  });

  it("stops a listed ticket from also being transferred", async () => {
    const { seller, ticketId } = await listableTicket();
    await createListing(seller.user.id, ticketId, 100000);
    const result = await createTransfer(seller.user.id, ticketId, `friend-${Date.now()}@example.com`);
    expect(result.ok).toBe(false);
  });
});

describe("cancelListing", { timeout: 180_000 }, () => {
  it("lets the seller cancel, and the ticket can then be listed again at a new price", async () => {
    const { seller, ticketId } = await listableTicket();
    await createListing(seller.user.id, ticketId, 150000);
    const listing = await prisma.ticketListing.findUniqueOrThrow({ where: { ticketId } });

    expect((await cancelListing(seller.user.id, listing.id)).ok).toBe(true);
    expect((await prisma.ticketListing.findUniqueOrThrow({ where: { id: listing.id } })).status).toBe("CANCELLED");

    expect((await createListing(seller.user.id, ticketId, 120000)).ok).toBe(true);
    const relisted = await prisma.ticketListing.findUniqueOrThrow({ where: { ticketId } });
    expect(relisted.id).toBe(listing.id); // the one row per ticket is reused
    expect(relisted.status).toBe("ACTIVE");
    expect(relisted.askingPrice).toBe(120000);
  });

  it("refuses anyone but the seller", async () => {
    const { seller, ticketId } = await listableTicket();
    await createListing(seller.user.id, ticketId, 150000);
    const listing = await prisma.ticketListing.findUniqueOrThrow({ where: { ticketId } });

    const stranger = await createTestUser();
    expect((await cancelListing(stranger.id, listing.id)).ok).toBe(false);
    expect((await prisma.ticketListing.findUniqueOrThrow({ where: { id: listing.id } })).status).toBe("ACTIVE");
  });

  it("refuses while a buyer's payment is in flight", async () => {
    const { seller, ticketId } = await listableTicket();
    await createListing(seller.user.id, ticketId, 150000);
    const buyer = await createTestUser();
    await prisma.ticketListing.update({
      where: { ticketId },
      data: { reservedByUserId: buyer.id, reservedUntil: new Date(Date.now() + 5 * 60 * 1000) },
    });
    const listing = await prisma.ticketListing.findUniqueOrThrow({ where: { ticketId } });

    const result = await cancelListing(seller.user.id, listing.id);
    expect(result.ok).toBe(false);
    expect((await prisma.ticketListing.findUniqueOrThrow({ where: { id: listing.id } })).status).toBe("ACTIVE");
  });
});

describe("purchaseListing", { timeout: 180_000 }, () => {
  async function activeListing(askingPrice = 150000) {
    const setup = await listableTicket();
    await createListing(setup.seller.user.id, setup.ticketId, askingPrice);
    const listing = await prisma.ticketListing.findUniqueOrThrow({ where: { ticketId: setup.ticketId } });
    return { ...setup, listing };
  }

  it("refuses the seller buying their own listing", async () => {
    const { seller, listing, ticketId } = await activeListing();

    const result = await purchaseListing(seller.user.id, listing.id, { phoneNumber: "0712345678" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("own listing");

    const after = await prisma.ticketListing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(after.status).toBe("ACTIVE");
    expect(after.reservedByUserId).toBeNull();
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(ticket.currentHolderUserId).toBeNull();
  });

  it("transfers ownership to the buyer and marks the listing SOLD", async () => {
    const { seller, listing, ticketId } = await activeListing(150000);
    const buyer = await userWithPhone();

    const result = await purchaseListing(buyer.user.id, listing.id, { phoneNumber: buyer.phone });
    expect(result).toMatchObject({ ok: true, status: "SOLD", ticketId });

    // The ticket now belongs to the buyer…
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(ticket.currentHolderUserId).toBe(buyer.user.id);
    // …the same physical ticket (code unchanged, still unused), not a new one.
    expect(ticket.checkedIn).toBe(false);

    const sold = await prisma.ticketListing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(sold.status).toBe("SOLD");
    expect(sold.buyerId).toBe(buyer.user.id);
    expect(sold.sellerId).toBe(seller.user.id);
    expect(sold.soldAt).not.toBeNull();
    expect(sold.reservedByUserId).toBeNull();

    // The buyer can see it as theirs; the seller no longer can.
    expect(await getTicketResaleState(buyer.user.id, ticketId)).not.toBeNull();
    expect(await getTicketResaleState(seller.user.id, ticketId)).toBeNull();
  });

  it("records the commission and what the seller is owed", async () => {
    const { listing } = await activeListing(150000);
    const buyer = await userWithPhone();
    await purchaseListing(buyer.user.id, listing.id, { phoneNumber: buyer.phone });

    const sold = await prisma.ticketListing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(sold.commissionAmount).toBe(7500); // 5% of 150000
    expect(sold.sellerPayoutAmount).toBe(142500);
    expect(sold.commissionAmount + sold.sellerPayoutAmount).toBe(sold.askingPrice);
    expect(sold.payoutStatus).toBe("PENDING");
  });

  it("sends WhatsApp confirmations to both the buyer and the seller", async () => {
    const { seller, listing } = await activeListing(150000);
    const buyer = await userWithPhone();
    await purchaseListing(buyer.user.id, listing.id, { phoneNumber: buyer.phone });

    const buyerLogs = await prisma.notificationLog.findMany({ where: { type: "TICKET_RESALE", recipient: buyer.phone } });
    expect(buyerLogs).toHaveLength(1);
    expect(buyerLogs[0].body).toContain("You bought");

    const sellerLogs = await prisma.notificationLog.findMany({
      where: { type: "TICKET_RESALE", recipient: seller.phone, subject: "Your ticket sold" },
    });
    expect(sellerLogs).toHaveLength(1);
    expect(sellerLogs[0].body).toContain("commission");
  });

  it("can't be bought twice", async () => {
    const { listing } = await activeListing();
    const first = await userWithPhone();
    const second = await userWithPhone();

    expect((await purchaseListing(first.user.id, listing.id, { phoneNumber: first.phone })).ok).toBe(true);
    const again = await purchaseListing(second.user.id, listing.id, { phoneNumber: second.phone });
    expect(again.ok).toBe(false);

    const after = await prisma.ticketListing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(after.buyerId).toBe(first.user.id);
  });

  it("holds the listing for one buyer while their payment is pending", async () => {
    const { listing } = await activeListing();
    const holder = await createTestUser();
    await prisma.ticketListing.update({
      where: { id: listing.id },
      data: { reservedByUserId: holder.id, reservedUntil: new Date(Date.now() + 5 * 60 * 1000) },
    });

    const other = await userWithPhone();
    const result = await purchaseListing(other.user.id, listing.id, { phoneNumber: other.phone });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Someone else");
    expect((await prisma.ticketListing.findUniqueOrThrow({ where: { id: listing.id } })).status).toBe("ACTIVE");
  });

  it("refuses when the ticket was checked in after it was listed", async () => {
    const { listing, ticketId } = await activeListing();
    await prisma.ticket.update({ where: { id: ticketId }, data: { checkedIn: true, checkedInAt: new Date() } });

    const buyer = await userWithPhone();
    const result = await purchaseListing(buyer.user.id, listing.id, { phoneNumber: buyer.phone });
    expect(result.ok).toBe(false);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(ticket.currentHolderUserId).toBeNull();
  });

  it("refuses when the organiser has switched resale off since the listing", async () => {
    const { listing, event } = await activeListing();
    await prisma.event.update({ where: { id: event.id }, data: { resaleEnabled: false } });
    const buyer = await userWithPhone();
    expect((await purchaseListing(buyer.user.id, listing.id, { phoneNumber: buyer.phone })).ok).toBe(false);
  });

  it("cancels any transfer the seller had pending when the sale completes", async () => {
    // A transfer can't be created while listed, but one created before a
    // (hypothetical) race must not survive the sale. Simulated directly.
    const { seller, listing, ticketId } = await activeListing();
    await prisma.ticketTransfer.create({
      data: {
        tokenHash: `hash-${Date.now()}-${Math.random()}`,
        toEmail: "x@example.com",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        ticketId,
        fromUserId: seller.user.id,
      },
    });
    const buyer = await userWithPhone();
    await purchaseListing(buyer.user.id, listing.id, { phoneNumber: buyer.phone });

    const transfers = await prisma.ticketTransfer.findMany({ where: { ticketId } });
    expect(transfers.every((t) => t.status === "CANCELLED")).toBe(true);
  });

  it("a resold ticket can't be listed again by the new holder", async () => {
    const { listing, ticketId } = await activeListing();
    const buyer = await userWithPhone();
    await purchaseListing(buyer.user.id, listing.id, { phoneNumber: buyer.phone });

    const relist = await createListing(buyer.user.id, ticketId, 100000);
    expect(relist.ok).toBe(false);
    if (!relist.ok) expect(relist.error).toContain("already bought through resale");
  });
});

describe("expiry", { timeout: 180_000 }, () => {
  it("auto-cancels a listing whose time is up", async () => {
    const { seller, ticketId } = await listableTicket();
    await createListing(seller.user.id, ticketId, 150000);
    await prisma.ticketListing.update({ where: { ticketId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    expect(await expireStaleListings()).toBeGreaterThanOrEqual(1);
    const listing = await prisma.ticketListing.findUniqueOrThrow({ where: { ticketId } });
    expect(listing.status).toBe("EXPIRED");
  });

  it("leaves a listing that hasn't expired yet alone", async () => {
    const { seller, ticketId } = await listableTicket();
    await createListing(seller.user.id, ticketId, 150000);
    await expireStaleListings();
    expect((await prisma.ticketListing.findUniqueOrThrow({ where: { ticketId } })).status).toBe("ACTIVE");
  });

  it("stops counting an expired listing on the event page even before the sweep has run", async () => {
    const { seller, ticketId, event } = await listableTicket();
    await createListing(seller.user.id, ticketId, 150000);
    expect(await countActiveListings(event.id)).toBe(1);

    // countActiveListings filters on expiresAt itself — no sweep involved.
    const later = new Date(Date.now() + 25 * 60 * 60 * 1000); // past the event start / expiry
    expect(await countActiveListings(event.id, later)).toBe(0);
    expect((await prisma.ticketListing.findUniqueOrThrow({ where: { ticketId } })).status).toBe("ACTIVE");
  });

  it("refuses to buy an expired listing", async () => {
    const { seller, ticketId } = await listableTicket();
    await createListing(seller.user.id, ticketId, 150000);
    const listing = await prisma.ticketListing.findUniqueOrThrow({ where: { ticketId } });
    await prisma.ticketListing.update({ where: { id: listing.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const buyer = await userWithPhone();
    const result = await purchaseListing(buyer.user.id, listing.id, { phoneNumber: buyer.phone });
    expect(result.ok).toBe(false);
    expect((await prisma.ticketListing.findUniqueOrThrow({ where: { id: listing.id } })).status).toBe("EXPIRED");
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })).currentHolderUserId).toBeNull();
  });

  it("lets an expired ticket be listed again", async () => {
    const { seller, ticketId } = await listableTicket();
    await createListing(seller.user.id, ticketId, 150000);
    await prisma.ticketListing.update({ where: { ticketId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expireStaleListings();

    expect((await createListing(seller.user.id, ticketId, 140000)).ok).toBe(true);
    const listing = await prisma.ticketListing.findUniqueOrThrow({ where: { ticketId } });
    expect(listing.status).toBe("ACTIVE");
    expect(listing.askingPrice).toBe(140000);
  });
});

describe("marketplace and reporting", { timeout: 180_000 }, () => {
  it("lists active listings cheapest first, with the savings, and flags the viewer's own", async () => {
    const first = await listableTicket();
    await createListing(first.seller.user.id, first.ticketId, 150000);

    // A second seller on the same event.
    const seller2 = await userWithPhone();
    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ticketType = await prisma.ticketType.findFirstOrThrow({ where: { eventId: first.event.id } });
    const sale = await handleSellTickets(seller2.user.id, {
      clientId: `resale-order2-${unique}`,
      eventId: first.event.id,
      items: [{ ticketTypeId: ticketType.id, quantity: 1, codes: [`RS2-${unique}`] }],
    });
    await createListing(seller2.user.id, sale.order!.tickets[0].id, 100000);

    const asFirstSeller = await getActiveListingsForEvent(first.event.id, first.seller.user.id);
    expect(asFirstSeller.map((l) => l.askingPrice)).toEqual([100000, 150000]);
    expect(asFirstSeller[1]).toMatchObject({ originalPrice: FACE_VALUE, savings: 50000, isOwn: true });
    expect(asFirstSeller[0].isOwn).toBe(false);

    const anonymous = await getActiveListingsForEvent(first.event.id, null);
    expect(anonymous.every((l) => l.isOwn === false)).toBe(true);
    // The seller's identity is never part of the public shape.
    expect(JSON.stringify(anonymous)).not.toContain(first.seller.user.id);
  });

  it("summarises resale commission separately, counting only completed sales", () => {
    const stats = summarizeResaleRevenue([
      { status: "SOLD", askingPrice: 150000, commissionAmount: 7500, currency: "TZS" },
      { status: "SOLD", askingPrice: 200000, commissionAmount: 10000, currency: "TZS" },
      { status: "SOLD", askingPrice: 5000, commissionAmount: 250, currency: "USD" },
      { status: "ACTIVE", askingPrice: 999999, commissionAmount: 0, currency: "TZS" },
      { status: "CANCELLED", askingPrice: 999999, commissionAmount: 0, currency: "TZS" },
      { status: "EXPIRED", askingPrice: 999999, commissionAmount: 0, currency: "TZS" },
    ]);
    expect(stats.salesCount).toBe(3);
    expect(stats.volumeByCurrency).toEqual({ TZS: 350000, USD: 5000 });
    expect(stats.commissionByCurrency).toEqual({ TZS: 17500, USD: 250 });
  });

  it("feeds an organiser's completed resales into the commission report", async () => {
    const { listing, organizationId } = await (async () => {
      const setup = await listableTicket();
      await createListing(setup.seller.user.id, setup.ticketId, 150000);
      const l = await prisma.ticketListing.findUniqueOrThrow({ where: { ticketId: setup.ticketId } });
      return { listing: l, organizationId: setup.organizationId };
    })();

    expect(summarizeResaleRevenue(await getOrganizerResaleListings(organizationId)).salesCount).toBe(0);

    const buyer = await userWithPhone();
    await purchaseListing(buyer.user.id, listing.id, { phoneNumber: buyer.phone });

    const stats = summarizeResaleRevenue(await getOrganizerResaleListings(organizationId));
    expect(stats.salesCount).toBe(1);
    expect(stats.commissionByCurrency).toEqual({ TZS: 7500 });
    expect(stats.volumeByCurrency).toEqual({ TZS: 150000 });
  });
});

describe("getTicketResaleState", { timeout: 180_000 }, () => {
  it("shows the holder an eligible ticket with its cap", async () => {
    const { seller, ticketId } = await listableTicket({ maxResalePrice: 150000 });
    const state = await getTicketResaleState(seller.user.id, ticketId);
    expect(state).toMatchObject({
      ticketId,
      originalPrice: FACE_VALUE,
      maxPrice: 150000,
      cannotListReason: null,
      listing: null,
    });
  });

  it("explains why a checked-in ticket can't be listed", async () => {
    const { seller, ticketId } = await listableTicket();
    await prisma.ticket.update({ where: { id: ticketId }, data: { checkedIn: true, checkedInAt: new Date() } });
    const state = await getTicketResaleState(seller.user.id, ticketId);
    expect(state?.cannotListReason).toContain("check in");
  });

  it("returns null for anyone who isn't the holder", async () => {
    const { ticketId } = await listableTicket();
    const stranger = await createTestUser();
    expect(await getTicketResaleState(stranger.id, ticketId)).toBeNull();
    expect(await getTicketResaleState(stranger.id, "no-such-ticket")).toBeNull();
  });

  it("shows the listing and the seller's payout once listed", async () => {
    const { seller, ticketId } = await listableTicket();
    await createListing(seller.user.id, ticketId, 150000);
    const state = await getTicketResaleState(seller.user.id, ticketId);
    expect(state?.listing).toMatchObject({ askingPrice: 150000, sellerPayoutAmount: 142500, buyerPaying: false });
    expect(state?.cannotListReason).toBeNull();
  });
});
