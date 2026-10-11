import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestEvent, createTestOrganization, createTestUser } from "@/lib/test-fixtures";
import {
  startPool,
  cancelPool,
  initiatePoolContribution,
  runPoolRefundSweep,
  summarizePoolActivity,
} from "@/lib/ticket-pool";

// Session 40 — Ticket Pools. Everything runs against the real test database
// (see vitest.global-setup.ts). .env has real AIRPAY_* credentials set (this
// is a deployed app with live mobile-money checkout), so
// getActivePaymentProvider() resolves to the real AirPay provider even in
// this test run, not the always-PAID simulator — same reason
// wallet-handlers.test.ts mocks both payment modules rather than relying on
// "no credentials configured". Same "assert against real rows, not mocks"
// discipline otherwise, matching wallet-transfer.test.ts.
const { mockInitiateCharge, mockVerifyAirpayOrder } = vi.hoisted(() => ({
  mockInitiateCharge: vi.fn(),
  mockVerifyAirpayOrder: vi.fn(),
}));
vi.mock("@/lib/payments", () => ({
  getActivePaymentProvider: () => ({
    name: "MOCK",
    isConfigured: () => true,
    initiateCharge: mockInitiateCharge,
  }),
}));
vi.mock("@/lib/payments/airpay", () => ({
  verifyAirpayOrder: mockVerifyAirpayOrder,
}));

beforeEach(() => {
  mockInitiateCharge.mockReset();
  mockInitiateCharge.mockResolvedValue({ status: "PAID", reference: "MOCK-REF" });
  mockVerifyAirpayOrder.mockReset();
});

afterEach(async () => {
  // Same Neon connection-pool drain as wallet-transfer.test.ts/wallet-handlers.test.ts.
  await new Promise((resolve) => setTimeout(resolve, 500));
});

let seq = 0;
const cid = (prefix: string) => `${prefix}-${Date.now()}-${++seq}`;

async function setupPoolable(priceCents: number, quantityTotal = 10) {
  const organization = await createTestOrganization();
  const event = await createTestEvent(organization.id, [{ priceCents, quantityTotal }]);
  const ticketType = event.ticketTypes[0];
  const creator = await createTestUser({ name: "Asha Kessy" });
  return { organization, event, ticketType, creator };
}

function expiresInDays(days: number) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

describe("startPool", () => {
  it("rejects a TIERED ticket type — a pool's price is frozen at creation and never recomputed", async () => {
    const organization = await createTestOrganization();
    const event = await createTestEvent(organization.id, [
      { priceCents: 1000, quantityTotal: 10, pricingStrategy: "TIERED", pricingTiers: [{ fromQuantity: 5, priceCents: 1500 }] },
    ]);
    const creator = await createTestUser();

    const result = await startPool({
      clientId: cid("pool"),
      ticketTypeId: event.ticketTypes[0].id,
      creatorUserId: creator.id,
      recipientUserId: creator.id,
      expiresAt: expiresInDays(7),
    });

    expect(result).toEqual({ ok: false, reason: "TIERED_NOT_SUPPORTED" });
  });

  it("freezes targetCents as priceCents * quantity at creation", async () => {
    const { ticketType, creator } = await setupPoolable(2000);
    const result = await startPool({
      clientId: cid("pool"),
      ticketTypeId: ticketType.id,
      creatorUserId: creator.id,
      recipientUserId: creator.id,
      quantity: 3,
      expiresAt: expiresInDays(7),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pool.targetCents).toBe(6000);
    expect(result.pool.status).toBe("OPEN");
    expect(result.pool.raisedCents).toBe(0);
  });
});

describe("initiatePoolContribution — happy path", () => {
  it("converts to a real Order + Ticket the moment a single contribution meets the target", async () => {
    const { ticketType, creator, event } = await setupPoolable(5000);
    const pool = await startPool({
      clientId: cid("pool"),
      ticketTypeId: ticketType.id,
      creatorUserId: creator.id,
      recipientUserId: creator.id,
      expiresAt: expiresInDays(7),
    });
    if (!pool.ok) throw new Error("pool creation failed");

    const contributor = await createTestUser({ name: "Baraka Mushi" });
    const result = await initiatePoolContribution({
      poolId: pool.pool.id,
      contributorUserId: contributor.id,
      amountCents: 5000,
      clientId: cid("contrib"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contribution.status).toBe("COMPLETED");
    expect(result.converted).toBe(true);

    const freshPool = await prisma.ticketPool.findUniqueOrThrow({ where: { id: pool.pool.id } });
    expect(freshPool.status).toBe("CONVERTED");
    expect(freshPool.raisedCents).toBe(5000);
    expect(freshPool.resultingOrderId).not.toBeNull();

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: freshPool.resultingOrderId! },
      include: { tickets: true, items: true },
    });
    expect(order.userId).toBe(creator.id); // creator === recipient in this flow
    expect(order.paymentMethod).toBe("POOL");
    expect(order.providerReference).toBeNull();
    expect(order.totalCents).toBe(5000);
    expect(order.tickets).toHaveLength(1);
    expect(order.tickets[0].eventId).toBe(event.id);

    const freshTicketType = await prisma.ticketType.findUniqueOrThrow({ where: { id: ticketType.id } });
    expect(freshTicketType.quantitySold).toBe(1);
  });

  it("rejects a contribution larger than what's left to raise", async () => {
    const { ticketType, creator } = await setupPoolable(5000);
    const pool = await startPool({
      clientId: cid("pool"),
      ticketTypeId: ticketType.id,
      creatorUserId: creator.id,
      recipientUserId: creator.id,
      expiresAt: expiresInDays(7),
    });
    if (!pool.ok) throw new Error("pool creation failed");

    const contributor = await createTestUser();
    const result = await initiatePoolContribution({
      poolId: pool.pool.id,
      contributorUserId: contributor.id,
      amountCents: 5001,
      clientId: cid("contrib"),
    });
    expect(result).toEqual({ ok: false, reason: "AMOUNT_EXCEEDS_REMAINING" });
  });

  it("leaves the pool OPEN after a partial contribution, with no order created", async () => {
    const { ticketType, creator } = await setupPoolable(5000);
    const pool = await startPool({
      clientId: cid("pool"),
      ticketTypeId: ticketType.id,
      creatorUserId: creator.id,
      recipientUserId: creator.id,
      expiresAt: expiresInDays(7),
    });
    if (!pool.ok) throw new Error("pool creation failed");

    const contributor = await createTestUser();
    const result = await initiatePoolContribution({
      poolId: pool.pool.id,
      contributorUserId: contributor.id,
      amountCents: 2000,
      clientId: cid("contrib"),
    });
    expect(result.ok && result.converted).toBe(false);

    const freshPool = await prisma.ticketPool.findUniqueOrThrow({ where: { id: pool.pool.id } });
    expect(freshPool.status).toBe("OPEN");
    expect(freshPool.raisedCents).toBe(2000);
  });
});

describe("the overfunding race", () => {
  it("lets exactly one of two simultaneous contributions that together exceed the target win — the loser is refunded, not stranded", async () => {
    const { ticketType, creator, event } = await setupPoolable(1000);
    const pool = await startPool({
      clientId: cid("pool"),
      ticketTypeId: ticketType.id,
      creatorUserId: creator.id,
      recipientUserId: creator.id,
      expiresAt: expiresInDays(7),
    });
    if (!pool.ok) throw new Error("pool creation failed");

    const [contributorA, contributorB] = await Promise.all([createTestUser(), createTestUser()]);

    // Each contribution (700) individually passes the early
    // AMOUNT_EXCEEDS_REMAINING check against the stale remaining (1000),
    // but together they overshoot the 1000 target — exactly the race the
    // bounded CAS in finishCompletedContribution exists to resolve.
    const [a, b] = await Promise.all([
      initiatePoolContribution({ poolId: pool.pool.id, contributorUserId: contributorA.id, amountCents: 700, clientId: cid("contrib") }),
      initiatePoolContribution({ poolId: pool.pool.id, contributorUserId: contributorB.id, amountCents: 700, clientId: cid("contrib") }),
    ]);
    if (!a.ok || !b.ok) throw new Error("contribution call failed outright");

    const statuses = [a.contribution.status, b.contribution.status].sort();
    expect(statuses).toEqual(["COMPLETED", "REFUNDED"]);

    const freshPool = await prisma.ticketPool.findUniqueOrThrow({ where: { id: pool.pool.id } });
    expect(freshPool.status).toBe("OPEN");
    expect(freshPool.raisedCents).toBe(700);

    const loser = a.contribution.status === "REFUNDED" ? contributorA : contributorB;
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { eventId_ownerUserId: { eventId: event.id, ownerUserId: loser.id } } });
    expect(wallet.balanceCents).toBe(700);

    const refundTx = await prisma.walletTransaction.findFirst({ where: { walletId: wallet.id, type: "POOL_REFUND" } });
    expect(refundTx?.status).toBe("COMPLETED");
    expect(refundTx?.amountCents).toBe(700);
  });
});

describe("sold-out at conversion", () => {
  it("refunds everyone and cancels the pool instead of handing out a ticket that no longer exists", async () => {
    const { ticketType, creator, event } = await setupPoolable(1000, 1); // only 1 ticket exists
    const pool = await startPool({
      clientId: cid("pool"),
      ticketTypeId: ticketType.id,
      creatorUserId: creator.id,
      recipientUserId: creator.id,
      expiresAt: expiresInDays(7),
    });
    if (!pool.ok) throw new Error("pool creation failed");

    // Simulate someone else buying the last ticket while the pool was
    // still filling, between pool creation and this contribution settling.
    await prisma.ticketType.update({ where: { id: ticketType.id }, data: { quantitySold: 1 } });

    const contributor = await createTestUser();
    const result = await initiatePoolContribution({
      poolId: pool.pool.id,
      contributorUserId: contributor.id,
      amountCents: 1000,
      clientId: cid("contrib"),
    });
    if (!result.ok) throw new Error("contribution call failed outright");

    expect(result.converted).toBe(false);
    expect(result.contribution.status).toBe("REFUNDED");

    const freshPool = await prisma.ticketPool.findUniqueOrThrow({ where: { id: pool.pool.id } });
    expect(freshPool.status).toBe("CANCELLED");
    expect(freshPool.cancelReason).toBe("SOLD_OUT_AT_CONVERSION");
    expect(freshPool.resultingOrderId).toBeNull();

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { eventId_ownerUserId: { eventId: event.id, ownerUserId: contributor.id } } });
    expect(wallet.balanceCents).toBe(1000);
  });
});

describe("expiry and the refund sweep", () => {
  it("refunds a partial contribution once the pool expires, and never double-refunds on a second sweep", async () => {
    const { ticketType, creator, event } = await setupPoolable(5000);
    const pool = await startPool({
      clientId: cid("pool"),
      ticketTypeId: ticketType.id,
      creatorUserId: creator.id,
      recipientUserId: creator.id,
      expiresAt: expiresInDays(1),
    });
    if (!pool.ok) throw new Error("pool creation failed");

    const contributor = await createTestUser();
    const contribution = await initiatePoolContribution({
      poolId: pool.pool.id,
      contributorUserId: contributor.id,
      amountCents: 2000,
      clientId: cid("contrib"),
    });
    if (!contribution.ok) throw new Error("contribution call failed outright");

    const afterExpiry = expiresInDays(2); // past the pool's 1-day deadline

    const firstSweep = await runPoolRefundSweep(afterExpiry);
    expect(firstSweep.expired).toBeGreaterThanOrEqual(1);
    expect(firstSweep.refunded).toBe(1);

    const freshPool = await prisma.ticketPool.findUniqueOrThrow({ where: { id: pool.pool.id } });
    expect(freshPool.status).toBe("EXPIRED");

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { eventId_ownerUserId: { eventId: event.id, ownerUserId: contributor.id } } });
    expect(wallet.balanceCents).toBe(2000);

    // Re-running the sweep must not refund the same contribution again.
    const secondSweep = await runPoolRefundSweep(afterExpiry);
    expect(secondSweep.refunded).toBe(0);

    const walletAfterSecondSweep = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(walletAfterSecondSweep.balanceCents).toBe(2000);
  });
});

describe("cancelPool", () => {
  it("lets only the creator cancel, and refunds any partial contribution", async () => {
    const { ticketType, creator, event } = await setupPoolable(5000);
    const pool = await startPool({
      clientId: cid("pool"),
      ticketTypeId: ticketType.id,
      creatorUserId: creator.id,
      recipientUserId: creator.id,
      expiresAt: expiresInDays(7),
    });
    if (!pool.ok) throw new Error("pool creation failed");

    const contributor = await createTestUser();
    const contribution = await initiatePoolContribution({
      poolId: pool.pool.id,
      contributorUserId: contributor.id,
      amountCents: 1500,
      clientId: cid("contrib"),
    });
    if (!contribution.ok) throw new Error("contribution call failed outright");

    const stranger = await createTestUser();
    const blocked = await cancelPool(pool.pool.id, stranger.id);
    expect(blocked).toEqual({ ok: false, reason: "FORBIDDEN" });

    const cancelled = await cancelPool(pool.pool.id, creator.id);
    expect(cancelled.ok).toBe(true);

    const freshPool = await prisma.ticketPool.findUniqueOrThrow({ where: { id: pool.pool.id } });
    expect(freshPool.status).toBe("CANCELLED");
    expect(freshPool.cancelReason).toBe("CREATOR_CANCELLED");

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { eventId_ownerUserId: { eventId: event.id, ownerUserId: contributor.id } } });
    expect(wallet.balanceCents).toBe(1500);
  });
});

describe("summarizePoolActivity", () => {
  it("partitions raised amounts by currency rather than summing across currencies", () => {
    const summary = summarizePoolActivity([
      { status: "CONVERTED", raisedCents: 5000, currency: "TZS" },
      { status: "OPEN", raisedCents: 2000, currency: "TZS" },
      { status: "CONVERTED", raisedCents: 1000, currency: "USD" },
    ]);
    expect(summary.poolCount).toBe(3);
    expect(summary.convertedCount).toBe(2);
    expect(summary.raisedByCurrency).toEqual({ TZS: 7000, USD: 1000 });
  });
});
