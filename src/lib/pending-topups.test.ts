import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestEvent, createTestUser, createTestOrganization, createTestWallet } from "@/lib/test-fixtures";
import { getPendingTopups, processPendingTopup, runPendingTopupSweep } from "@/lib/pending-topups";

// Session 35 — verifyAirpayOrder is imported directly from
// @/lib/payments/airpay, same as wallet-handlers.test.ts, so it gets its own
// hoisted mock. It is keyed by merchant order id below so one sweep can see a
// different AirPay answer per transaction.
const { mockVerifyAirpayOrder } = vi.hoisted(() => ({ mockVerifyAirpayOrder: vi.fn() }));
vi.mock("@/lib/payments/airpay", () => ({
  verifyAirpayOrder: mockVerifyAirpayOrder,
}));

function airpayAnswers(answers: Record<string, { status: "PAID" | "FAILED" | "PENDING"; message?: string }>) {
  mockVerifyAirpayOrder.mockImplementation(async (ref: string) => {
    const answer = answers[ref];
    if (!answer) throw new Error(`unexpected verifyAirpayOrder(${ref})`);
    return { ...answer, reference: ref };
  });
}

let seq = 0;
const HOUR = 60 * 60 * 1000;

beforeEach(async () => {
  mockVerifyAirpayOrder.mockReset();
  // The sweep reads every PENDING top-up in the shared test database, so any
  // left behind by other test files would inflate this file's counts. Tests
  // run sequentially, and nothing else relies on those leftovers staying open.
  await prisma.walletTransaction.updateMany({
    where: { type: "TOPUP", status: "PENDING" },
    data: { status: "FAILED" },
  });
});

// Same Neon connection-pool drain as wallet-handlers.test.ts.
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
});

async function setup(opts: { balanceCents?: number; phone?: string | null } = {}) {
  const organization = await createTestOrganization();
  const owner = await createTestUser();
  if (opts.phone !== null) {
    await prisma.user.update({ where: { id: owner.id }, data: { phone: opts.phone ?? `+25570${String(++seq).padStart(7, "0")}` } });
  }
  const event = await createTestEvent(organization.id);
  const wallet = await createTestWallet(event.id, owner.id, { balanceCents: opts.balanceCents ?? 0 });
  return { owner, wallet };
}

async function pendingTopup(
  walletId: string,
  overrides: Partial<{ amountCents: number; providerReference: string | null; createdAt: Date; type: string; status: string }> = {}
) {
  const n = ++seq;
  return prisma.walletTransaction.create({
    data: {
      clientId: `pending-topup-${Date.now()}-${n}`,
      type: overrides.type ?? "TOPUP",
      status: overrides.status ?? "PENDING",
      amountCents: overrides.amountCents ?? 500_000,
      currency: "TZS",
      providerReference: overrides.providerReference === undefined ? `AP-PT-${Date.now()}-${n}` : overrides.providerReference,
      walletId,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    },
  });
}

describe("runPendingTopupSweep — confirmed", () => {
  it("credits the wallet, marks the top-up COMPLETED with its airpayRef, and sends the WhatsApp confirmation", async () => {
    const { owner, wallet } = await setup({ balanceCents: 100_000 });
    const tx = await pendingTopup(wallet.id, { amountCents: 500_000 });
    airpayAnswers({ [tx.providerReference!]: { status: "PAID", message: "Success" } });

    const result = await runPendingTopupSweep();

    expect(result).toMatchObject({ ok: true, processed: 1, confirmed: 1, failed: 0, stillPending: 0 });
    const updatedTx = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: tx.id } });
    expect(updatedTx.status).toBe("COMPLETED");
    expect(updatedTx.airpayRef).toBe(tx.providerReference);
    const updatedWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(updatedWallet.balanceCents).toBe(600_000);

    const phone = (await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).phone!;
    const log = await prisma.notificationLog.findFirst({ where: { recipient: phone, type: "WALLET_TOPUP_CONFIRMED" } });
    expect(log).not.toBeNull();
    expect(log!.channel).toBe("WHATSAPP");
    expect(log!.body).toContain("Your top-up of");
    expect(log!.body).toContain("5,000");
    expect(log!.body).toContain("has been confirmed — your new balance is");
    expect(log!.body).toContain("6,000");
  });

  it("credits the balance even when the attendee has no phone on file (no notification, no error)", async () => {
    const { wallet } = await setup({ phone: null });
    const tx = await pendingTopup(wallet.id, { amountCents: 200_000 });
    airpayAnswers({ [tx.providerReference!]: { status: "PAID" } });

    const result = await runPendingTopupSweep();

    expect(result.confirmed).toBe(1);
    expect((await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } })).balanceCents).toBe(200_000);
  });
});

describe("runPendingTopupSweep — failed", () => {
  it("marks a declined top-up FAILED, leaves the balance alone, and sends no notification", async () => {
    const { owner, wallet } = await setup({ balanceCents: 100_000 });
    const tx = await pendingTopup(wallet.id);
    airpayAnswers({ [tx.providerReference!]: { status: "FAILED", message: "Insufficient funds" } });

    const result = await runPendingTopupSweep();

    expect(result).toMatchObject({ processed: 1, confirmed: 0, failed: 1, stillPending: 0 });
    const updatedTx = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: tx.id } });
    expect(updatedTx.status).toBe("FAILED");
    expect(updatedTx.providerMessage).toBe("Insufficient funds");
    expect(updatedTx.airpayRef).toBeNull();
    expect((await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } })).balanceCents).toBe(100_000);

    const phone = (await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).phone!;
    expect(await prisma.notificationLog.count({ where: { recipient: phone } })).toBe(0);
  });
});

describe("runPendingTopupSweep — still pending", () => {
  it("leaves a top-up AirPay still reports as PENDING completely unchanged for the next run", async () => {
    const { wallet } = await setup({ balanceCents: 100_000 });
    const tx = await pendingTopup(wallet.id);
    airpayAnswers({ [tx.providerReference!]: { status: "PENDING" } });

    const result = await runPendingTopupSweep();

    expect(result).toMatchObject({ processed: 1, confirmed: 0, failed: 0, stillPending: 1 });
    const after = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: tx.id } });
    expect(after.status).toBe("PENDING");
    expect(after.airpayRef).toBeNull();
    expect((await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } })).balanceCents).toBe(100_000);
  });

  it("leaves a top-up PENDING (and keeps sweeping the rest) when AirPay can't be reached for it", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { wallet: walletA } = await setup();
    const { wallet: walletB } = await setup();
    const broken = await pendingTopup(walletA.id, { providerReference: "AP-PT-BROKEN" });
    const good = await pendingTopup(walletB.id, { amountCents: 300_000 });
    mockVerifyAirpayOrder.mockImplementation(async (ref: string) => {
      if (ref === "AP-PT-BROKEN") throw new Error("AirPay timeout");
      return { status: "PAID", reference: ref };
    });

    const result = await runPendingTopupSweep();

    expect(result).toMatchObject({ processed: 2, confirmed: 1, stillPending: 1 });
    expect((await prisma.walletTransaction.findUniqueOrThrow({ where: { id: broken.id } })).status).toBe("PENDING");
    expect((await prisma.walletTransaction.findUniqueOrThrow({ where: { id: good.id } })).status).toBe("COMPLETED");
    errorSpy.mockRestore();
  });

  it("does not call AirPay for a top-up that has no merchant order id", async () => {
    const { wallet } = await setup();
    const tx = await pendingTopup(wallet.id, { providerReference: null });

    const result = await runPendingTopupSweep();

    expect(result.stillPending).toBe(1);
    expect(mockVerifyAirpayOrder).not.toHaveBeenCalled();
    expect((await prisma.walletTransaction.findUniqueOrThrow({ where: { id: tx.id } })).status).toBe("PENDING");
  });
});

describe("getPendingTopups — age window and type filter", () => {
  it("ignores top-ups older than 24 hours and never polls AirPay for them", async () => {
    const { wallet } = await setup({ balanceCents: 100_000 });
    const stale = await pendingTopup(wallet.id, { createdAt: new Date(Date.now() - 25 * HOUR) });
    const fresh = await pendingTopup(wallet.id, { createdAt: new Date(Date.now() - 23 * HOUR) });
    airpayAnswers({ [fresh.providerReference!]: { status: "PAID" } });

    const ids = (await getPendingTopups()).map((t) => t.id);
    expect(ids).toContain(fresh.id);
    expect(ids).not.toContain(stale.id);

    const result = await runPendingTopupSweep();

    expect(result).toMatchObject({ processed: 1, confirmed: 1 });
    expect(mockVerifyAirpayOrder).toHaveBeenCalledTimes(1);
    expect(mockVerifyAirpayOrder).not.toHaveBeenCalledWith(stale.providerReference);
    const after = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: stale.id } });
    expect(after.status).toBe("PENDING");
  });

  it("only picks up PENDING TOPUP rows — not other types or already-resolved top-ups", async () => {
    const { wallet } = await setup();
    const topup = await pendingTopup(wallet.id);
    const sale = await pendingTopup(wallet.id, { type: "SALE" });
    const done = await pendingTopup(wallet.id, { status: "COMPLETED" });

    const ids = (await getPendingTopups()).map((t) => t.id);
    expect(ids).toContain(topup.id);
    expect(ids).not.toContain(sale.id);
    expect(ids).not.toContain(done.id);
  });
});

describe("runPendingTopupSweep — idempotency", () => {
  it("is safe to run repeatedly: the balance is credited once and AirPay is asked once", async () => {
    const { wallet } = await setup({ balanceCents: 0 });
    const tx = await pendingTopup(wallet.id, { amountCents: 500_000 });
    airpayAnswers({ [tx.providerReference!]: { status: "PAID" } });

    const first = await runPendingTopupSweep();
    const second = await runPendingTopupSweep();

    expect(first).toMatchObject({ processed: 1, confirmed: 1 });
    expect(second).toMatchObject({ processed: 0, confirmed: 0, failed: 0, stillPending: 0 });
    expect(mockVerifyAirpayOrder).toHaveBeenCalledTimes(1);
    expect((await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } })).balanceCents).toBe(500_000);
  });

  it("does not double-credit when the app's own poll resolved the top-up between the sweep's query and its write", async () => {
    const { owner, wallet } = await setup({ balanceCents: 0 });
    const tx = await pendingTopup(wallet.id, { amountCents: 500_000 });
    airpayAnswers({ [tx.providerReference!]: { status: "PAID" } });

    // The sweep loaded this row while PENDING...
    const [stale] = (await getPendingTopups()).filter((t) => t.id === tx.id);
    // ...then the app's handleCheckTopupStatus credited it first.
    await prisma.$transaction([
      prisma.walletTransaction.update({ where: { id: tx.id }, data: { status: "COMPLETED", airpayRef: tx.providerReference } }),
      prisma.wallet.update({ where: { id: wallet.id }, data: { balanceCents: { increment: 500_000 } } }),
    ]);

    const outcome = await processPendingTopup(stale);

    expect(outcome).toBe("ALREADY_RESOLVED");
    expect((await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } })).balanceCents).toBe(500_000);
    const phone = (await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).phone!;
    expect(await prisma.notificationLog.count({ where: { recipient: phone } })).toBe(0);
  });
});

describe("runPendingTopupSweep — mixed batch", () => {
  it("resolves each top-up independently and reports one count per outcome", async () => {
    const [a, b, c] = await Promise.all([setup(), setup(), setup()]);
    const paid = await pendingTopup(a.wallet.id, { amountCents: 100_000 });
    const declined = await pendingTopup(b.wallet.id);
    const waiting = await pendingTopup(c.wallet.id);
    airpayAnswers({
      [paid.providerReference!]: { status: "PAID" },
      [declined.providerReference!]: { status: "FAILED" },
      [waiting.providerReference!]: { status: "PENDING" },
    });

    const result = await runPendingTopupSweep();

    expect(result).toEqual({ ok: true, processed: 3, confirmed: 1, failed: 1, stillPending: 1, alreadyResolved: 0 });
  });
});
