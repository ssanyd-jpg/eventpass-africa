import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestUser, createTestOrganization, addMembership, createTestEvent } from "@/lib/test-fixtures";
import {
  createSeasonPass,
  publishSeasonPass,
  linkEventToSeasonPass,
  purchaseSeasonPass,
  getSeasonPassHolders,
  isSeasonPassHolder,
} from "@/lib/season-pass";

// Season ticket / membership management foundation. DB-backed, run against
// the real test database (see vitest.global-setup.ts), same convention as
// marathon-results.test.ts/post-event-memory.test.ts. WhatsApp goes through
// the LOGGED fallback in test (no AT credentials), so sends are asserted via
// NotificationLog rows.
//
// purchaseSeasonPass calls getActivePaymentProvider().initiateCharge(), same
// as resale.ts's purchaseListing — with AIRPAY_* fully configured in this
// repo's .env, that would otherwise hit the real (403-ing) Airpay API (see
// payments/index.test.ts's own AIRPAY_VARS-clearing trick, which this file
// reuses) rather than the deterministic PAID-always simulator.
const AIRPAY_VARS = [
  "AIRPAY_MERCHANT_ID",
  "AIRPAY_CLIENT_ID",
  "AIRPAY_CLIENT_SECRET",
  "AIRPAY_USERNAME",
  "AIRPAY_PASSWORD",
  "AIRPAY_SECRET",
  "AIRPAY_MERCHANT_DOMAIN",
] as const;
const originalAirpayValues = Object.fromEntries(AIRPAY_VARS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  for (const k of AIRPAY_VARS) delete process.env[k];
});

afterEach(async () => {
  for (const k of AIRPAY_VARS) {
    const original = originalAirpayValues[k];
    if (original === undefined) delete process.env[k];
    else process.env[k] = original;
  }
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

function seasonDates(daysFromNow = 90) {
  const startDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
  const endDate = new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);
  return { startDate, endDate };
}

async function createdActivePass(organizationId: string, overrides: Partial<Parameters<typeof createSeasonPass>[1]> = {}) {
  const { startDate, endDate } = seasonDates();
  const created = await createSeasonPass(organizationId, {
    name: "Simba SC 2026/27 Season",
    price: 5_000_00,
    startDate,
    endDate,
    ...overrides,
  });
  if (!created.ok) throw new Error(created.error);
  await publishSeasonPass(organizationId, created.seasonPassId);
  return created.seasonPassId;
}

describe("createSeasonPass", () => {
  it("creates a pass in DRAFT status", async () => {
    const { organizationId } = await newOrganizer();
    const { startDate, endDate } = seasonDates();
    const result = await createSeasonPass(organizationId, { name: "Young Africans 2026/27 Season", price: 4_000_00, startDate, endDate });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const pass = await prisma.seasonPass.findUniqueOrThrow({ where: { id: result.seasonPassId } });
    expect(pass.status).toBe("DRAFT");
    expect(pass.autoRenewEnabled).toBe(false);
  });

  it("rejects a non-positive price", async () => {
    const { organizationId } = await newOrganizer();
    const { startDate, endDate } = seasonDates();
    const result = await createSeasonPass(organizationId, { name: "Bad Pass", price: 0, startDate, endDate });
    expect(result.ok).toBe(false);
  });

  it("rejects an end date before the start date", async () => {
    const { organizationId } = await newOrganizer();
    const result = await createSeasonPass(organizationId, {
      name: "Backwards Pass",
      price: 100_00,
      startDate: new Date(),
      endDate: new Date(Date.now() - 86_400_000),
    });
    expect(result.ok).toBe(false);
  });
});

describe("publishSeasonPass", () => {
  it("moves a DRAFT pass to ACTIVE", async () => {
    const { organizationId } = await newOrganizer();
    const { startDate, endDate } = seasonDates();
    const created = await createSeasonPass(organizationId, { name: "Draft Pass", price: 100_00, startDate, endDate });
    if (!created.ok) throw new Error(created.error);

    const result = await publishSeasonPass(organizationId, created.seasonPassId);
    expect(result.ok).toBe(true);

    const pass = await prisma.seasonPass.findUniqueOrThrow({ where: { id: created.seasonPassId } });
    expect(pass.status).toBe("ACTIVE");
  });

  it("rejects a different organisation's pass", async () => {
    const { organizationId } = await newOrganizer();
    const { organizationId: otherOrgId } = await newOrganizer();
    const { startDate, endDate } = seasonDates();
    const created = await createSeasonPass(organizationId, { name: "Someone Else's Pass", price: 100_00, startDate, endDate });
    if (!created.ok) throw new Error(created.error);

    const result = await publishSeasonPass(otherOrgId, created.seasonPassId);
    expect(result.ok).toBe(false);
  });
});

describe("linkEventToSeasonPass", () => {
  it("links an event and is idempotent on a repeat link", async () => {
    const { organizationId } = await newOrganizer();
    const seasonPassId = await createdActivePass(organizationId);
    const event = await createTestEvent(organizationId);

    const first = await linkEventToSeasonPass(organizationId, seasonPassId, event.id);
    expect(first.ok).toBe(true);

    const second = await linkEventToSeasonPass(organizationId, seasonPassId, event.id);
    expect(second.ok).toBe(true);

    const links = await prisma.seasonPassEvent.count({ where: { seasonPassId, eventId: event.id } });
    expect(links).toBe(1);
  });

  it("rejects an event belonging to a different organisation", async () => {
    const { organizationId } = await newOrganizer();
    const { organizationId: otherOrgId } = await newOrganizer();
    const seasonPassId = await createdActivePass(organizationId);
    const foreignEvent = await createTestEvent(otherOrgId);

    const result = await linkEventToSeasonPass(organizationId, seasonPassId, foreignEvent.id);
    expect(result.ok).toBe(false);
  });
});

describe("purchaseSeasonPass", () => {
  it("creates a holder and sends a WhatsApp confirmation", async () => {
    const { organizationId } = await newOrganizer();
    const seasonPassId = await createdActivePass(organizationId);
    const buyer = await createTestUser({ name: "Amina Juma" });

    const result = await purchaseSeasonPass(seasonPassId, { userId: buyer.id, name: buyer.name, phone: "0712345678" });
    expect(result.ok).toBe(true);
    if (!result.ok || result.status !== "CONFIRMED") throw new Error("expected a confirmed purchase");

    const holder = await prisma.seasonPassHolder.findUniqueOrThrow({ where: { id: result.holderId } });
    expect(holder.renewalStatus).toBe("ACTIVE");
    expect(holder.phone).toBe("+255712345678");

    const log = await prisma.notificationLog.findFirstOrThrow({ where: { type: "SEASON_PASS_PURCHASED", recipient: holder.phone } });
    // "Club Name" in the WhatsApp template is the organisation's name
    // (displayName ?? name — see clubNameFor in season-pass.ts), not the
    // SeasonPass row's own `name` field ("Simba SC 2026/27 Season").
    expect(log.body).toContain("Test Org");
    expect(log.body).toContain("confirmed");
  });

  it("rejects a purchase on a DRAFT (unpublished) pass", async () => {
    const { organizationId } = await newOrganizer();
    const { startDate, endDate } = seasonDates();
    const created = await createSeasonPass(organizationId, { name: "Still Draft", price: 100_00, startDate, endDate });
    if (!created.ok) throw new Error(created.error);
    const buyer = await createTestUser();

    const result = await purchaseSeasonPass(created.seasonPassId, { userId: buyer.id, name: buyer.name, phone: "0712345678" });
    expect(result.ok).toBe(false);
  });

  it("rejects a purchase once maxHolders is reached", async () => {
    const { organizationId } = await newOrganizer();
    const seasonPassId = await createdActivePass(organizationId, { maxHolders: 1 });

    const first = await createTestUser({ name: "First Buyer" });
    const firstPurchase = await purchaseSeasonPass(seasonPassId, { userId: first.id, name: first.name, phone: "0712345671" });
    expect(firstPurchase.ok).toBe(true);

    const second = await createTestUser({ name: "Second Buyer" });
    const secondPurchase = await purchaseSeasonPass(seasonPassId, { userId: second.id, name: second.name, phone: "0712345672" });
    expect(secondPurchase.ok).toBe(false);
  });
});

describe("getSeasonPassHolders", () => {
  it("lists every holder for a pass, most recent first", async () => {
    const { organizationId } = await newOrganizer();
    const seasonPassId = await createdActivePass(organizationId);
    const buyerA = await createTestUser({ name: "Buyer A" });
    const buyerB = await createTestUser({ name: "Buyer B" });
    await purchaseSeasonPass(seasonPassId, { userId: buyerA.id, name: buyerA.name, phone: "0712000001" });
    await purchaseSeasonPass(seasonPassId, { userId: buyerB.id, name: buyerB.name, phone: "0712000002" });

    const holders = await getSeasonPassHolders(seasonPassId);
    expect(holders).toHaveLength(2);
    expect(holders.map((h) => h.name).sort()).toEqual(["Buyer A", "Buyer B"]);
  });
});

describe("isSeasonPassHolder", () => {
  it("returns true for a holder whose pass covers the event", async () => {
    const { organizationId } = await newOrganizer();
    const seasonPassId = await createdActivePass(organizationId);
    const event = await createTestEvent(organizationId);
    await linkEventToSeasonPass(organizationId, seasonPassId, event.id);
    const buyer = await createTestUser();
    await purchaseSeasonPass(seasonPassId, { userId: buyer.id, name: buyer.name, phone: "0712345678" });

    expect(await isSeasonPassHolder(buyer.id, event.id)).toBe(true);
  });

  it("returns false for an event not linked to the buyer's pass", async () => {
    const { organizationId } = await newOrganizer();
    const seasonPassId = await createdActivePass(organizationId);
    const unlinkedEvent = await createTestEvent(organizationId);
    const buyer = await createTestUser();
    await purchaseSeasonPass(seasonPassId, { userId: buyer.id, name: buyer.name, phone: "0712345678" });

    expect(await isSeasonPassHolder(buyer.id, unlinkedEvent.id)).toBe(false);
  });

  it("returns false for a user who never purchased a pass", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const stranger = await createTestUser();

    expect(await isSeasonPassHolder(stranger.id, event.id)).toBe(false);
  });
});
