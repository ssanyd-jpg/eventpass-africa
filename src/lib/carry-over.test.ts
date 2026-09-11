import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createTestUser,
  createTestOrganization,
  createTestEvent,
  createTestWallet,
} from "@/lib/test-fixtures";
import { handleCarryOverWallet, handleCreateWallet } from "@/lib/sync-handlers";
import { eventHasEnded, findCarryOverCandidate, summarizeCarryOverVolume } from "@/lib/carry-over";

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

const PAST = new Date(Date.now() - 7 * 86400000);
const FUTURE = new Date(Date.now() + 7 * 86400000);

// A source event (already ended) with a funded wallet for `owner`, plus a
// target event that opts into carry-over — the common setup for the
// handler tests.
async function setup(opts: { targetCarryOver?: boolean; sourceEnded?: boolean; sourceBalance?: number } = {}) {
  const owner = await createTestUser();
  const org = await createTestOrganization();

  const sourceEvent = await createTestEvent(org.id);
  await prisma.event.update({
    where: { id: sourceEvent.id },
    data: { startsAt: PAST, endsAt: opts.sourceEnded === false ? FUTURE : PAST },
  });
  const sourceWallet = await createTestWallet(sourceEvent.id, owner.id, {
    balanceCents: opts.sourceBalance ?? 40_000,
  });

  const targetEvent = await createTestEvent(org.id);
  await prisma.event.update({
    where: { id: targetEvent.id },
    data: { carryOverEnabled: opts.targetCarryOver ?? true },
  });

  return { owner, org, sourceEvent, sourceWallet, targetEvent };
}

function carryPayload(targetEventId: string, sourceWalletId: string) {
  return { clientId: uid("wallet"), code: uid("W").toUpperCase(), eventId: targetEventId, sourceWalletId };
}

describe("eventHasEnded", () => {
  it("uses endsAt when set, falling back to startsAt", () => {
    expect(eventHasEnded({ startsAt: FUTURE, endsAt: PAST })).toBe(true);
    expect(eventHasEnded({ startsAt: PAST, endsAt: FUTURE })).toBe(false);
    expect(eventHasEnded({ startsAt: PAST })).toBe(true);
    expect(eventHasEnded({ startsAt: FUTURE })).toBe(false);
  });
});

describe("findCarryOverCandidate", () => {
  const target = { id: "t1", organizationId: "org1", currency: "TZS", startsAt: FUTURE, carryOverEnabled: true };

  it("returns the highest-balance eligible wallet from the same organiser's ended events", () => {
    const c = findCarryOverCandidate({
      targetEvent: target,
      wallets: [
        { wallet: { id: "w1", eventId: "e1", balanceCents: 5_000, currency: "TZS" }, event: { id: "e1", title: "Small Fest", organizationId: "org1", currency: "TZS", startsAt: PAST, carryOverEnabled: false } },
        { wallet: { id: "w2", eventId: "e2", balanceCents: 12_000, currency: "TZS" }, event: { id: "e2", title: "Big Fest", organizationId: "org1", currency: "TZS", startsAt: PAST, carryOverEnabled: false } },
      ],
    });
    expect(c?.sourceWalletId).toBe("w2");
    expect(c?.sourceEventTitle).toBe("Big Fest");
    expect(c?.balanceCents).toBe(12_000);
  });

  it("returns null when the target event hasn't enabled carry-over", () => {
    expect(findCarryOverCandidate({ targetEvent: { ...target, carryOverEnabled: false }, wallets: [
      { wallet: { id: "w1", eventId: "e1", balanceCents: 5_000, currency: "TZS" }, event: { id: "e1", title: "F", organizationId: "org1", currency: "TZS", startsAt: PAST, carryOverEnabled: false } },
    ] })).toBeNull();
  });

  it("excludes other organisers, ongoing events, cross-currency and empty wallets", () => {
    const c = findCarryOverCandidate({
      targetEvent: target,
      wallets: [
        { wallet: { id: "a", eventId: "e", balanceCents: 9_000, currency: "TZS" }, event: { id: "e", title: "Other org", organizationId: "org2", currency: "TZS", startsAt: PAST, carryOverEnabled: false } },
        { wallet: { id: "b", eventId: "e", balanceCents: 9_000, currency: "TZS" }, event: { id: "e", title: "Not over", organizationId: "org1", currency: "TZS", startsAt: FUTURE, carryOverEnabled: false } },
        { wallet: { id: "c", eventId: "e", balanceCents: 9_000, currency: "USD" }, event: { id: "e", title: "USD", organizationId: "org1", currency: "USD", startsAt: PAST, carryOverEnabled: false } },
        { wallet: { id: "d", eventId: "e", balanceCents: 0, currency: "TZS" }, event: { id: "e", title: "Empty", organizationId: "org1", currency: "TZS", startsAt: PAST, carryOverEnabled: false } },
      ],
    });
    expect(c).toBeNull();
  });
});

describe("summarizeCarryOverVolume", () => {
  it("sums only positive (credit) COMPLETED CARRY_OVER rows, by currency", () => {
    const out = summarizeCarryOverVolume([
      { type: "CARRY_OVER", status: "COMPLETED", amountCents: 10_000, currency: "TZS" },
      { type: "CARRY_OVER", status: "COMPLETED", amountCents: -10_000, currency: "TZS" }, // the debit half — ignored
      { type: "CARRY_OVER", status: "COMPLETED", amountCents: 4_000, currency: "TZS" },
      { type: "TOPUP", status: "COMPLETED", amountCents: 99_000, currency: "TZS" }, // not carry-over
    ]);
    expect(out).toEqual({ TZS: 14_000 });
  });
});

describe("handleCarryOverWallet", () => {
  it("credits the new wallet, zeroes the source, and records a CARRY_OVER row on each", async () => {
    const { owner, sourceWallet, targetEvent } = await setup({ sourceBalance: 40_000 });

    const result: any = await handleCarryOverWallet(owner.id, carryPayload(targetEvent.id, sourceWallet.id));
    expect(result.ok).toBe(true);
    expect(result.carriedCents).toBe(40_000);
    expect(result.wallet.balanceCents).toBe(40_000);
    expect(result.wallet.carryOverSourceWalletId).toBe(sourceWallet.id);
    expect(result.wallet.carryOverredAt).not.toBeNull();

    const source = await prisma.wallet.findUniqueOrThrow({ where: { id: sourceWallet.id } });
    expect(source.balanceCents).toBe(0);

    const txs = await prisma.walletTransaction.findMany({
      where: { type: "CARRY_OVER", walletId: { in: [sourceWallet.id, result.wallet.id] } },
      orderBy: { amountCents: "asc" },
    });
    expect(txs).toHaveLength(2);
    expect(txs[0]).toMatchObject({ walletId: sourceWallet.id, amountCents: -40_000, status: "COMPLETED" });
    expect(txs[1]).toMatchObject({ walletId: result.wallet.id, amountCents: 40_000, status: "COMPLETED" });
  });

  it("is a no-op on the source when the buyer declines (a plain CREATE_WALLET instead)", async () => {
    const { owner, sourceWallet, targetEvent } = await setup({ sourceBalance: 25_000 });

    await handleCreateWallet(owner.id, {
      clientId: uid("w"),
      code: uid("W").toUpperCase(),
      eventId: targetEvent.id,
    });

    const source = await prisma.wallet.findUniqueOrThrow({ where: { id: sourceWallet.id } });
    expect(source.balanceCents).toBe(25_000);
    const carryTxs = await prisma.walletTransaction.count({ where: { type: "CARRY_OVER", walletId: sourceWallet.id } });
    expect(carryTxs).toBe(0);
  });

  it("is blocked when the target event has carryOverEnabled = false", async () => {
    const { owner, sourceWallet, targetEvent } = await setup({ targetCarryOver: false });
    const result: any = await handleCarryOverWallet(owner.id, carryPayload(targetEvent.id, sourceWallet.id));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("CARRY_OVER_NOT_ENABLED");
    const source = await prisma.wallet.findUniqueOrThrow({ where: { id: sourceWallet.id } });
    expect(source.balanceCents).toBe(40_000);
  });

  it("is blocked when the source event has not ended", async () => {
    const { owner, sourceWallet, targetEvent } = await setup({ sourceEnded: false });
    const result: any = await handleCarryOverWallet(owner.id, carryPayload(targetEvent.id, sourceWallet.id));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("SOURCE_EVENT_NOT_ENDED");
    const source = await prisma.wallet.findUniqueOrThrow({ where: { id: sourceWallet.id } });
    expect(source.balanceCents).toBe(40_000);
  });

  it("is blocked when the source wallet balance is zero", async () => {
    const { owner, sourceWallet, targetEvent } = await setup({ sourceBalance: 0 });
    const result: any = await handleCarryOverWallet(owner.id, carryPayload(targetEvent.id, sourceWallet.id));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("SOURCE_BALANCE_ZERO");
  });

  it("rejects a source wallet that isn't the caller's", async () => {
    const { sourceWallet, targetEvent } = await setup();
    const stranger = await createTestUser();
    const result: any = await handleCarryOverWallet(stranger.id, carryPayload(targetEvent.id, sourceWallet.id));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("FORBIDDEN");
  });

  it("is idempotent — replaying the same clientId returns the wallet without carrying twice", async () => {
    const { owner, sourceWallet, targetEvent } = await setup({ sourceBalance: 30_000 });
    const payload = carryPayload(targetEvent.id, sourceWallet.id);

    const first: any = await handleCarryOverWallet(owner.id, payload);
    const second: any = await handleCarryOverWallet(owner.id, payload);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.wallet.id).toBe(first.wallet.id);
    const credits = await prisma.walletTransaction.count({
      where: { type: "CARRY_OVER", walletId: first.wallet.id, amountCents: 30_000 },
    });
    expect(credits).toBe(1);
  });
});
