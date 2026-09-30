import { describe, expect, it, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestUser, createTestOrganization, addMembership, createTestEvent } from "@/lib/test-fixtures";

// Same provider-mocking discipline as ussd.test.ts/wallet-handlers.test.ts:
// with no real Airpay credentials the active provider is the simulator
// (always PAID), so the PENDING/FAILED branches a real provider returns can
// only be reached by mocking getActivePaymentProvider. Defaults to PAID
// here (unlike ussd.test.ts's PENDING default) since most of this file's
// tests exercise the confirmed-purchase path. vi.hoisted for the reason
// spelled out in whatsapp.test.ts.
const { mockInitiateCharge } = vi.hoisted(() => ({ mockInitiateCharge: vi.fn() }));
vi.mock("@/lib/payments", () => ({
  getActivePaymentProvider: () => ({
    name: "MOCK",
    isConfigured: () => true,
    initiateCharge: mockInitiateCharge,
  }),
}));

import {
  expireListings,
  getFeaturedSlotAvailability,
  createFeaturedListing,
  estimateBroadcastReach,
  createBroadcast,
  sendBroadcast,
  getAdminAdsSummary,
  FEATURED_LISTING_PRICING,
  BROADCAST_MESSAGE_MAX_LENGTH,
} from "@/lib/chaap-ads";

beforeEach(() => {
  mockInitiateCharge.mockReset();
  mockInitiateCharge.mockResolvedValue({ status: "PAID", reference: "MOCK-PAID-REF" });
});

let seq = 0;
function uniquePhone() {
  seq += 1;
  return `0712${String(Date.now() % 1_000_000).padStart(6, "0")}${seq}`.slice(0, 12);
}

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { user, organizationId: organization.id };
}

async function typedEvent(organizationId: string, eventType: string) {
  const event = await createTestEvent(organizationId);
  return prisma.event.update({ where: { id: event.id }, data: { eventType } });
}

// createFeaturedListing's slot cap is small (3 FEATURED / 1 SPOTLIGHT) and
// genuinely platform-wide, so — unlike every other fixture in this shared
// test database — a test that leaves its own listing ACTIVE would starve
// every later test in this same run that needs to create one of its own.
// Called after a test's own assertions, once the row's ACTIVE state is no
// longer needed.
async function expireOrgListings(organizationId: string) {
  await prisma.featuredListing.updateMany({ where: { organizationId, status: "ACTIVE" }, data: { status: "EXPIRED" } });
}

describe("createFeaturedListing", () => {
  it("creates an ACTIVE listing and charges the organiser on a confirmed payment", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);

    const result = await createFeaturedListing(event.id, "FEATURED", organizationId, { phoneNumber: uniquePhone() });
    expect(result.ok).toBe(true);
    if (!result.ok || result.status !== "CONFIRMED") throw new Error("expected a confirmed listing");

    const listing = await prisma.featuredListing.findUniqueOrThrow({ where: { id: result.listingId } });
    expect(listing.tier).toBe("FEATURED");
    expect(listing.status).toBe("ACTIVE");
    expect(listing.amountPaidCents).toBe(FEATURED_LISTING_PRICING.FEATURED.amountCents);
    expect(mockInitiateCharge).toHaveBeenCalledTimes(1);

    await expireOrgListings(organizationId);
  });

  // "payment required before listing goes live" — a declined charge must
  // never create a listing row, and a PENDING one must not create one
  // either (see purchaseSeasonPass's identical "no webhook to resolve a
  // PENDING charge later" limitation).
  it("creates no listing when the payment is declined", async () => {
    mockInitiateCharge.mockResolvedValueOnce({ status: "FAILED", reference: "MOCK-FAILED-REF", message: "Insufficient funds" });
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);

    const result = await createFeaturedListing(event.id, "FEATURED", organizationId, { phoneNumber: uniquePhone() });
    expect(result.ok).toBe(false);

    const count = await prisma.featuredListing.count({ where: { eventId: event.id } });
    expect(count).toBe(0);
  });

  it("creates no listing while the payment is still PENDING", async () => {
    mockInitiateCharge.mockResolvedValueOnce({ status: "PENDING", reference: "MOCK-PENDING-REF", message: "Approve on your phone" });
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);

    const result = await createFeaturedListing(event.id, "FEATURED", organizationId, { phoneNumber: uniquePhone() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe("PENDING");

    const count = await prisma.featuredListing.count({ where: { eventId: event.id } });
    expect(count).toBe(0);
  });

  it("rejects a second active listing for the same event", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);

    const first = await createFeaturedListing(event.id, "FEATURED", organizationId, { phoneNumber: uniquePhone() });
    expect(first.ok).toBe(true);

    const second = await createFeaturedListing(event.id, "SPOTLIGHT", organizationId, { phoneNumber: uniquePhone() });
    expect(second.ok).toBe(false);

    await expireOrgListings(organizationId);
  });

  it("rejects a non-LIVE event", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    await prisma.event.update({ where: { id: event.id }, data: { status: "CANCELLED" } });

    const result = await createFeaturedListing(event.id, "FEATURED", organizationId, { phoneNumber: uniquePhone() });
    expect(result.ok).toBe(false);
  });

  // Platform-wide slot cap — fills whatever's actually left first, rather
  // than assuming an exact starting count, since this codebase's tests all
  // share one never-cleaned-up database (see season-pass.test.ts's own
  // comment on this) and other tests in this file also create listings.
  it("enforces the max active FEATURED slot count", async () => {
    const { organizationId } = await newOrganizer();
    const before = await getFeaturedSlotAvailability();

    for (let i = 0; i < before.FEATURED; i++) {
      const event = await createTestEvent(organizationId);
      const result = await createFeaturedListing(event.id, "FEATURED", organizationId, { phoneNumber: uniquePhone() });
      expect(result.ok).toBe(true);
    }

    const overflowEvent = await createTestEvent(organizationId);
    const overflow = await createFeaturedListing(overflowEvent.id, "FEATURED", organizationId, { phoneNumber: uniquePhone() });
    expect(overflow.ok).toBe(false);

    const after = await getFeaturedSlotAvailability();
    expect(after.FEATURED).toBe(0);

    // Free the slots this test claimed — otherwise every later test in this
    // file that needs its own FEATURED listing (expireListings',
    // getAdminAdsSummary's) would find the platform-wide cap already full.
    await prisma.featuredListing.updateMany({ where: { organizationId, status: "ACTIVE" }, data: { status: "EXPIRED" } });
  });

  it("enforces the max active SPOTLIGHT slot count", async () => {
    const { organizationId } = await newOrganizer();
    const before = await getFeaturedSlotAvailability();

    for (let i = 0; i < before.SPOTLIGHT; i++) {
      const event = await createTestEvent(organizationId);
      const result = await createFeaturedListing(event.id, "SPOTLIGHT", organizationId, { phoneNumber: uniquePhone() });
      expect(result.ok).toBe(true);
    }

    const overflowEvent = await createTestEvent(organizationId);
    const overflow = await createFeaturedListing(overflowEvent.id, "SPOTLIGHT", organizationId, { phoneNumber: uniquePhone() });
    expect(overflow.ok).toBe(false);

    const after = await getFeaturedSlotAvailability();
    expect(after.SPOTLIGHT).toBe(0);

    // Same cleanup as the FEATURED test above.
    await prisma.featuredListing.updateMany({ where: { organizationId, status: "ACTIVE" }, data: { status: "EXPIRED" } });
  });
});

describe("expireListings", () => {
  it("marks an ACTIVE listing past its endDate as EXPIRED", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const result = await createFeaturedListing(event.id, "FEATURED", organizationId, { phoneNumber: uniquePhone() });
    if (!result.ok || result.status !== "CONFIRMED") throw new Error("expected a confirmed listing");

    await prisma.featuredListing.update({ where: { id: result.listingId }, data: { endDate: new Date(Date.now() - 1000) } });

    await expireListings();
    const listing = await prisma.featuredListing.findUniqueOrThrow({ where: { id: result.listingId } });
    expect(listing.status).toBe("EXPIRED");
  });

  it("leaves a not-yet-expired ACTIVE listing untouched", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const result = await createFeaturedListing(event.id, "FEATURED", organizationId, { phoneNumber: uniquePhone() });
    if (!result.ok || result.status !== "CONFIRMED") throw new Error("expected a confirmed listing");

    await expireListings();
    const listing = await prisma.featuredListing.findUniqueOrThrow({ where: { id: result.listingId } });
    expect(listing.status).toBe("ACTIVE");

    await expireOrgListings(organizationId);
  });
});

describe("estimateBroadcastReach", () => {
  // Platform-wide, so assertions compare a BEFORE/AFTER delta rather than an
  // exact count — same "shared, never-cleaned-up test database" reasoning
  // as the slot-cap tests above; other rows may already exist.
  it("counts a user with a phone and a PAID order for a matching event type", async () => {
    const { organizationId } = await newOrganizer();
    const event = await typedEvent(organizationId, "MARATHON");

    const before = await estimateBroadcastReach(["MARATHON"]);

    const buyer = await createTestUser();
    await prisma.user.update({ where: { id: buyer.id }, data: { phone: "+255712000001" } });
    await prisma.order.create({
      data: { userId: buyer.id, eventId: event.id, status: "PAID", totalCents: 1000, currency: "TZS" },
    });

    const after = await estimateBroadcastReach(["MARATHON"]);
    expect(after).toBe(before + 1);
  });

  it("excludes a matching buyer with no phone on file", async () => {
    const { organizationId } = await newOrganizer();
    const event = await typedEvent(organizationId, "MARATHON");

    const before = await estimateBroadcastReach(["MARATHON"]);

    const buyer = await createTestUser();
    await prisma.order.create({
      data: { userId: buyer.id, eventId: event.id, status: "PAID", totalCents: 1000, currency: "TZS" },
    });

    const after = await estimateBroadcastReach(["MARATHON"]);
    expect(after).toBe(before);
  });

  it("excludes a buyer of a non-matching event type", async () => {
    const { organizationId } = await newOrganizer();
    const event = await typedEvent(organizationId, "FOOTBALL");

    const before = await estimateBroadcastReach(["MARATHON"]);

    const buyer = await createTestUser();
    await prisma.user.update({ where: { id: buyer.id }, data: { phone: "+255712000002" } });
    await prisma.order.create({
      data: { userId: buyer.id, eventId: event.id, status: "PAID", totalCents: 1000, currency: "TZS" },
    });

    const after = await estimateBroadcastReach(["MARATHON"]);
    expect(after).toBe(before);
  });

  it("counts a buyer of any event type when targetEventTypes is empty (\"All attendees\")", async () => {
    const { organizationId } = await newOrganizer();
    const event = await typedEvent(organizationId, "CONCERT");

    const before = await estimateBroadcastReach([]);

    const buyer = await createTestUser();
    await prisma.user.update({ where: { id: buyer.id }, data: { phone: "+255712000003" } });
    await prisma.order.create({
      data: { userId: buyer.id, eventId: event.id, status: "PAID", totalCents: 1000, currency: "TZS" },
    });

    const after = await estimateBroadcastReach([]);
    expect(after).toBe(before + 1);
  });
});

describe("createBroadcast", () => {
  it("rejects a message over the 160-character limit", async () => {
    const { organizationId } = await newOrganizer();
    const result = await createBroadcast(organizationId, "a".repeat(BROADCAST_MESSAGE_MAX_LENGTH + 1), [], new Date(), {
      phoneNumber: uniquePhone(),
    });
    expect(result.ok).toBe(false);
  });

  it("accepts a message at exactly the 160-character limit and charges the minimum for a small reach", async () => {
    const { organizationId } = await newOrganizer();
    const event = await typedEvent(organizationId, "MARATHON");
    const buyer = await createTestUser();
    await prisma.user.update({ where: { id: buyer.id }, data: { phone: "+255712000004" } });
    await prisma.order.create({
      data: { userId: buyer.id, eventId: event.id, status: "PAID", totalCents: 1000, currency: "TZS" },
    });

    const result = await createBroadcast(organizationId, "a".repeat(BROADCAST_MESSAGE_MAX_LENGTH), ["MARATHON"], new Date(), {
      phoneNumber: uniquePhone(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.status !== "CONFIRMED") throw new Error("expected a confirmed broadcast");
    expect(result.amountPaidCents).toBeGreaterThanOrEqual(25_000_00); // BROADCAST_MIN_AMOUNT_CENTS
  });

  it("creates no broadcast when the payment is declined", async () => {
    mockInitiateCharge.mockResolvedValueOnce({ status: "FAILED", reference: "MOCK-FAILED-REF", message: "Declined" });
    const { organizationId } = await newOrganizer();
    const event = await typedEvent(organizationId, "MARATHON");
    const buyer = await createTestUser();
    await prisma.user.update({ where: { id: buyer.id }, data: { phone: "+255712000005" } });
    await prisma.order.create({
      data: { userId: buyer.id, eventId: event.id, status: "PAID", totalCents: 1000, currency: "TZS" },
    });

    const before = await prisma.adBroadcast.count({ where: { organizationId } });
    const result = await createBroadcast(organizationId, "Hello!", ["MARATHON"], new Date(), { phoneNumber: uniquePhone() });
    expect(result.ok).toBe(false);
    const after = await prisma.adBroadcast.count({ where: { organizationId } });
    expect(after).toBe(before);
  });
});

describe("sendBroadcast", () => {
  it("sends WhatsApp to every matching attendee and records sentAt/recipientCount", async () => {
    const { organizationId } = await newOrganizer();
    const event = await typedEvent(organizationId, "FESTIVAL");
    const buyer = await createTestUser();
    await prisma.user.update({ where: { id: buyer.id }, data: { phone: "+255712000006" } });
    await prisma.order.create({
      data: { userId: buyer.id, eventId: event.id, status: "PAID", totalCents: 1000, currency: "TZS" },
    });

    const created = await createBroadcast(organizationId, "Big festival discount!", ["FESTIVAL"], new Date(), {
      phoneNumber: uniquePhone(),
    });
    if (!created.ok || created.status !== "CONFIRMED") throw new Error("expected a confirmed broadcast");

    const sent = await sendBroadcast(created.broadcastId);
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(sent.result.recipientCount).toBeGreaterThanOrEqual(1);

    const broadcast = await prisma.adBroadcast.findUniqueOrThrow({ where: { id: created.broadcastId } });
    expect(broadcast.status).toBe("SENT");
    expect(broadcast.sentAt).not.toBeNull();
    expect(broadcast.recipientCount).toBe(sent.result.recipientCount);

    const log = await prisma.notificationLog.findFirstOrThrow({ where: { type: "AD_BROADCAST", recipient: "+255712000006" } });
    expect(log.body).toBe("Big festival discount!");
  });

  it("refuses to send the same broadcast twice", async () => {
    const { organizationId } = await newOrganizer();
    const event = await typedEvent(organizationId, "FESTIVAL");
    const buyer = await createTestUser();
    await prisma.user.update({ where: { id: buyer.id }, data: { phone: "+255712000007" } });
    await prisma.order.create({
      data: { userId: buyer.id, eventId: event.id, status: "PAID", totalCents: 1000, currency: "TZS" },
    });

    const created = await createBroadcast(organizationId, "Second send test", ["FESTIVAL"], new Date(), {
      phoneNumber: uniquePhone(),
    });
    if (!created.ok || created.status !== "CONFIRMED") throw new Error("expected a confirmed broadcast");

    const first = await sendBroadcast(created.broadcastId);
    expect(first.ok).toBe(true);

    const second = await sendBroadcast(created.broadcastId);
    expect(second.ok).toBe(false);
  });
});

describe("getAdminAdsSummary", () => {
  // Also platform-wide and "this month"-scoped, so — same reasoning as
  // estimateBroadcastReach's tests — assert on a before/after delta.
  it("reflects a newly-paid listing's revenue and active count", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);

    const before = await getAdminAdsSummary();
    const listing = await createFeaturedListing(event.id, "FEATURED", organizationId, { phoneNumber: uniquePhone() });
    if (!listing.ok || listing.status !== "CONFIRMED") throw new Error("expected a confirmed listing");
    const after = await getAdminAdsSummary();

    expect(after.totalAdRevenueCentsThisMonth - before.totalAdRevenueCentsThisMonth).toBe(FEATURED_LISTING_PRICING.FEATURED.amountCents);
    expect(after.activeFeaturedListings - before.activeFeaturedListings).toBe(1);

    await expireOrgListings(organizationId);
  });

  it("reflects a sent broadcast's revenue, sent count, and recipient count", async () => {
    const { organizationId } = await newOrganizer();
    const event = await typedEvent(organizationId, "MARATHON");
    const buyer = await createTestUser();
    await prisma.user.update({ where: { id: buyer.id }, data: { phone: "+255712000008" } });
    await prisma.order.create({
      data: { userId: buyer.id, eventId: event.id, status: "PAID", totalCents: 1000, currency: "TZS" },
    });

    const before = await getAdminAdsSummary();
    const created = await createBroadcast(organizationId, "Admin summary test", ["MARATHON"], new Date(), {
      phoneNumber: uniquePhone(),
    });
    if (!created.ok || created.status !== "CONFIRMED") throw new Error("expected a confirmed broadcast");
    const sent = await sendBroadcast(created.broadcastId);
    if (!sent.ok) throw new Error("expected the broadcast to send");
    const after = await getAdminAdsSummary();

    expect(after.totalAdRevenueCentsThisMonth - before.totalAdRevenueCentsThisMonth).toBe(created.amountPaidCents);
    expect(after.broadcastsSentThisMonth - before.broadcastsSentThisMonth).toBe(1);
    expect(after.totalBroadcastRecipientsThisMonth - before.totalBroadcastRecipientsThisMonth).toBe(sent.result.recipientCount);
  });
});
