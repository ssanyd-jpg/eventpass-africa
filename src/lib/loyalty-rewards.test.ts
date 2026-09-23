import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestUser, createTestOrganization, addMembership, createTestEvent, createPaidOrder, createTestWallet } from "@/lib/test-fixtures";
import {
  createReward,
  listRewards,
  toggleReward,
  getEligibleRewards,
  redeemReward,
  tierMeetsRequirement,
  validateRewardValue,
} from "@/lib/loyalty-rewards";

// Real Postgres, no per-test reset — every phone used as a WhatsApp
// recipient must be unique across runs, same discipline as resale.test.ts.
function uniquePhone() {
  return `+2557${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
}

async function userWithPhone() {
  const user = await createTestUser();
  const phone = uniquePhone();
  await prisma.user.update({ where: { id: user.id }, data: { phone } });
  return { user, phone };
}

// A fresh organisation with a LIVE event (one ticket type, face value
// FACE_VALUE) — independent per call, like resale.test.ts's listableTicket.
const FACE_VALUE = 200000;
async function orgWithEvent() {
  const organizer = await createTestUser();
  const org = await createTestOrganization();
  await addMembership(org.id, organizer.id, "OWNER");
  const event = await createTestEvent(org.id, [{ priceCents: FACE_VALUE, quantityTotal: 3 }]);
  return { organizationId: org.id, event, ticketTypeId: event.ticketTypes[0].id };
}

// Buys `ordersCount` paid orders for `userId` with this organisation, each
// against its own throwaway event, so getMyLoyaltyStatuses computes the
// exact tier the test wants (NEW < 2, REPEAT 2-4, VIP >= 5 — see loyalty.ts).
async function buyOrders(organizationId: string, userId: string, ordersCount: number) {
  await Promise.all(Array.from({ length: ordersCount }, () => createPaidOrder(organizationId, userId, 50000)));
}

describe("loyalty rewards pricing rules", () => {
  it("ranks tiers VIP > REPEAT > NEW and treats the requirement as a floor", () => {
    expect(tierMeetsRequirement("VIP", "NEW")).toBe(true);
    expect(tierMeetsRequirement("VIP", "REPEAT")).toBe(true);
    expect(tierMeetsRequirement("VIP", "VIP")).toBe(true);
    expect(tierMeetsRequirement("REPEAT", "VIP")).toBe(false);
    expect(tierMeetsRequirement("NEW", "REPEAT")).toBe(false);
    expect(tierMeetsRequirement("NEW", "NEW")).toBe(true);
  });

  it("validates a discount code reward's value as 1-100%", () => {
    expect(validateRewardValue("DISCOUNT_CODE", 10)).toEqual({ ok: true });
    expect(validateRewardValue("DISCOUNT_CODE", 100)).toEqual({ ok: true });
    expect(validateRewardValue("DISCOUNT_CODE", 0).ok).toBe(false);
    expect(validateRewardValue("DISCOUNT_CODE", 101).ok).toBe(false);
    expect(validateRewardValue("DISCOUNT_CODE", 1.5).ok).toBe(false);
  });

  it("validates a wallet credit reward's value as a positive amount", () => {
    expect(validateRewardValue("WALLET_CREDIT", 5000)).toEqual({ ok: true });
    expect(validateRewardValue("WALLET_CREDIT", 0).ok).toBe(false);
    expect(validateRewardValue("WALLET_CREDIT", -100).ok).toBe(false);
  });
});

describe("createReward", { timeout: 180_000 }, () => {
  it("creates a reward with the given fields", async () => {
    const own = await orgWithEvent();
    const real = await createReward(own.organizationId, {
      name: "10% off",
      description: "A loyalty discount",
      rewardType: "DISCOUNT_CODE",
      value: 10,
      requiredTier: "REPEAT",
      stock: 5,
      eventId: own.event.id,
      ticketTypeId: own.ticketTypeId,
    });
    expect(real.ok).toBe(true);
    if (!real.ok) return;
    const reward = await prisma.loyaltyReward.findUniqueOrThrow({ where: { id: real.rewardId } });
    expect(reward.name).toBe("10% off");
    expect(reward.rewardType).toBe("DISCOUNT_CODE");
    expect(reward.value).toBe(10);
    expect(reward.requiredTier).toBe("REPEAT");
    expect(reward.stock).toBe(5);
    expect(reward.redeemedCount).toBe(0);
    expect(reward.active).toBe(true);
    expect(reward.eventId).toBe(own.event.id);
    expect(reward.ticketTypeId).toBe(own.ticketTypeId);
  });

  it("rejects a ticket type that doesn't belong to the organisation's own event", async () => {
    const own = await orgWithEvent();
    const other = await orgWithEvent();
    const result = await createReward(own.organizationId, {
      name: "Cross-org",
      rewardType: "DISCOUNT_CODE",
      value: 10,
      requiredTier: "NEW",
      eventId: other.event.id,
      ticketTypeId: other.ticketTypeId,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a DISCOUNT_CODE/FREE_TICKET reward with no event or ticket type", async () => {
    const { organizationId } = await orgWithEvent();
    const result = await createReward(organizationId, {
      name: "Free ticket",
      rewardType: "FREE_TICKET",
      value: 0,
      requiredTier: "VIP",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("event and ticket type");
  });

  it("rejects an invalid value for the reward type", async () => {
    const { organizationId } = await orgWithEvent();
    const result = await createReward(organizationId, {
      name: "Too much off",
      rewardType: "DISCOUNT_CODE",
      value: 500,
      requiredTier: "NEW",
    });
    expect(result.ok).toBe(false);
  });

  it("lists rewards with their redemption counts, newest first", async () => {
    const { organizationId } = await orgWithEvent();
    await createReward(organizationId, { name: "First", rewardType: "CUSTOM", value: 0, requiredTier: "NEW" });
    await createReward(organizationId, { name: "Second", rewardType: "CUSTOM", value: 0, requiredTier: "NEW" });
    const list = await listRewards(organizationId);
    expect(list.map((r) => r.name)).toEqual(["Second", "First"]);
    expect(list.every((r) => r.redeemedCount === 0)).toBe(true);
  });

  it("toggles a reward active/inactive, scoped to its own organisation", async () => {
    const { organizationId } = await orgWithEvent();
    const other = await createTestOrganization();
    const created = await createReward(organizationId, { name: "Toggle me", rewardType: "CUSTOM", value: 0, requiredTier: "NEW" });
    if (!created.ok) throw new Error("setup failed");

    const wrongOrg = await toggleReward(other.id, created.rewardId, false);
    expect(wrongOrg.ok).toBe(false);

    const off = await toggleReward(organizationId, created.rewardId, false);
    expect(off.ok).toBe(true);
    expect((await prisma.loyaltyReward.findUniqueOrThrow({ where: { id: created.rewardId } })).active).toBe(false);
  });
});

describe("getEligibleRewards", { timeout: 180_000 }, () => {
  it("only returns rewards the attendee's tier qualifies for", async () => {
    const { organizationId } = await orgWithEvent();
    await createReward(organizationId, { name: "Everyone", rewardType: "CUSTOM", value: 0, requiredTier: "NEW" });
    await createReward(organizationId, { name: "VIP only", rewardType: "CUSTOM", value: 0, requiredTier: "VIP" });

    const { user: newUser } = await userWithPhone();
    const newResult = await getEligibleRewards(newUser.id, organizationId);
    expect(newResult.tier).toBe("NEW");
    expect(newResult.rewards.map((r) => r.name)).toEqual(["Everyone"]);

    const { user: vip } = await userWithPhone();
    await buyOrders(organizationId, vip.id, 5);
    const vipResult = await getEligibleRewards(vip.id, organizationId);
    expect(vipResult.tier).toBe("VIP");
    expect(vipResult.rewards.map((r) => r.name).sort()).toEqual(["Everyone", "VIP only"]);
  });

  it("reports how many more orders are needed for the next tier", async () => {
    const { organizationId } = await orgWithEvent();
    const { user } = await userWithPhone();
    const result = await getEligibleRewards(user.id, organizationId);
    expect(result.progress).toEqual({ tier: "NEW", nextTier: "REPEAT", ordersToNextTier: 2 });
  });
});

describe("redeemReward", { timeout: 180_000 }, () => {
  it("creates a redemption record with the correct reward, user, tier, and value", async () => {
    const { organizationId } = await orgWithEvent();
    const created = await createReward(organizationId, {
      name: "Merch stand",
      description: "Show this at the merch stand",
      rewardType: "CUSTOM",
      value: 0,
      requiredTier: "NEW",
    });
    if (!created.ok) throw new Error("setup failed");
    const { user, phone } = await userWithPhone();

    const result = await redeemReward(user.id, created.rewardId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const redemption = await prisma.loyaltyRedemption.findUniqueOrThrow({ where: { id: result.redemptionId } });
    expect(redemption.rewardId).toBe(created.rewardId);
    expect(redemption.userId).toBe(user.id);
    expect(redemption.tier).toBe("NEW");
    expect(redemption.value).toBe(0);

    expect((await prisma.loyaltyReward.findUniqueOrThrow({ where: { id: created.rewardId } })).redeemedCount).toBe(1);

    const logs = await prisma.notificationLog.findMany({ where: { type: "LOYALTY_REWARD", recipient: phone } });
    expect(logs).toHaveLength(1);
    expect(logs[0].body).toContain("Show this at the merch stand");
  });

  it("DISCOUNT_CODE generates a unique code, tagged with the reward, one-time use", async () => {
    const { organizationId, event, ticketTypeId } = await orgWithEvent();
    const created = await createReward(organizationId, {
      name: "10% off",
      rewardType: "DISCOUNT_CODE",
      value: 10,
      requiredTier: "NEW",
      eventId: event.id,
      ticketTypeId,
    });
    if (!created.ok) throw new Error("setup failed");

    const a = await userWithPhone();
    const b = await userWithPhone();
    const resultA = await redeemReward(a.user.id, created.rewardId);
    const resultB = await redeemReward(b.user.id, created.rewardId);
    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    if (!resultA.ok || !resultB.ok) return;

    const codeA = await prisma.discountCode.findUniqueOrThrow({ where: { id: resultA.discountCodeId! } });
    const codeB = await prisma.discountCode.findUniqueOrThrow({ where: { id: resultB.discountCodeId! } });
    expect(codeA.code).not.toBe(codeB.code);
    expect(codeA.loyaltyRewardId).toBe(created.rewardId);
    expect(codeA.type).toBe("PERCENT_OFF");
    expect(codeA.percentOff).toBe(10);
    expect(codeA.maxRedemptions).toBe(1);
    expect(codeA.eventId).toBe(event.id);
    expect(codeA.ticketTypeId).toBe(ticketTypeId);
  });

  it("WALLET_CREDIT credits the attendee's active event wallet and logs a LOYALTY_CREDIT transaction", async () => {
    const { organizationId } = await orgWithEvent();
    const created = await createReward(organizationId, {
      name: "TZS 5,000 credit",
      rewardType: "WALLET_CREDIT",
      value: 5000,
      requiredTier: "NEW",
    });
    if (!created.ok) throw new Error("setup failed");

    const { user } = await userWithPhone();
    const liveEvent = await createTestEvent(organizationId);
    const wallet = await createTestWallet(liveEvent.id, user.id, { balanceCents: 1000 });

    const result = await redeemReward(user.id, created.rewardId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const updatedWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(updatedWallet.balanceCents).toBe(6000);

    const txn = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: result.walletTransactionId! } });
    expect(txn.type).toBe("LOYALTY_CREDIT");
    expect(txn.status).toBe("COMPLETED");
    expect(txn.amountCents).toBe(5000);
    expect(txn.walletId).toBe(wallet.id);
  });

  it("WALLET_CREDIT is refused when the attendee has no active wallet with this organiser", async () => {
    const { organizationId } = await orgWithEvent();
    const created = await createReward(organizationId, { name: "Credit", rewardType: "WALLET_CREDIT", value: 1000, requiredTier: "NEW" });
    if (!created.ok) throw new Error("setup failed");
    const { user } = await userWithPhone();

    const result = await redeemReward(user.id, created.rewardId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("active wallet");
  });

  it("FREE_TICKET generates a real ticket for the specified event and consumes inventory", async () => {
    const { organizationId, event, ticketTypeId } = await orgWithEvent();
    const created = await createReward(organizationId, {
      name: "Free General ticket",
      rewardType: "FREE_TICKET",
      value: 0,
      requiredTier: "NEW",
      eventId: event.id,
      ticketTypeId,
    });
    if (!created.ok) throw new Error("setup failed");
    const { user, phone } = await userWithPhone();

    const before = await prisma.ticketType.findUniqueOrThrow({ where: { id: ticketTypeId } });
    const result = await redeemReward(user.id, created.rewardId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: result.ticketId! }, include: { order: true } });
    expect(ticket.eventId).toBe(event.id);
    expect(ticket.ticketTypeId).toBe(ticketTypeId);
    expect(ticket.order.userId).toBe(user.id);
    expect(ticket.order.totalCents).toBe(0);
    expect(result.value).toBe(FACE_VALUE); // the face value handed over, not the unused reward.value

    const after = await prisma.ticketType.findUniqueOrThrow({ where: { id: ticketTypeId } });
    expect(after.quantitySold).toBe(before.quantitySold + 1);

    const logs = await prisma.notificationLog.findMany({ where: { type: "LOYALTY_REWARD", recipient: phone } });
    expect(logs[0].body).toContain(ticket.code);
  });

  it("enforces the stock limit — a second redemption is refused once stock runs out", async () => {
    const { organizationId } = await orgWithEvent();
    const created = await createReward(organizationId, { name: "Only one", rewardType: "CUSTOM", value: 0, requiredTier: "NEW", stock: 1 });
    if (!created.ok) throw new Error("setup failed");

    const a = await userWithPhone();
    const b = await userWithPhone();
    const first = await redeemReward(a.user.id, created.rewardId);
    const second = await redeemReward(b.user.id, created.rewardId);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/stock|no longer available/i);

    expect((await prisma.loyaltyReward.findUniqueOrThrow({ where: { id: created.rewardId } })).redeemedCount).toBe(1);
    expect(await prisma.loyaltyRedemption.count({ where: { rewardId: created.rewardId } })).toBe(1);
  });

  it("rejects redeeming an expired reward and creates nothing", async () => {
    const { organizationId } = await orgWithEvent();
    const created = await createReward(organizationId, {
      name: "Expired",
      rewardType: "CUSTOM",
      value: 0,
      requiredTier: "NEW",
      expiresAt: new Date(Date.now() - 1000),
    });
    if (!created.ok) throw new Error("setup failed");
    const { user } = await userWithPhone();

    const result = await redeemReward(user.id, created.rewardId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("expired");
    expect(await prisma.loyaltyRedemption.count({ where: { rewardId: created.rewardId } })).toBe(0);
  });

  it("rejects a second redemption of the same reward by the same attendee", async () => {
    const { organizationId } = await orgWithEvent();
    const created = await createReward(organizationId, { name: "One per person", rewardType: "CUSTOM", value: 0, requiredTier: "NEW" });
    if (!created.ok) throw new Error("setup failed");
    const { user } = await userWithPhone();

    const first = await redeemReward(user.id, created.rewardId);
    const second = await redeemReward(user.id, created.rewardId);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain("already redeemed");

    expect(await prisma.loyaltyRedemption.count({ where: { rewardId: created.rewardId, userId: user.id } })).toBe(1);
  });

  it("rejects redemption below the required tier", async () => {
    const { organizationId } = await orgWithEvent();
    const created = await createReward(organizationId, { name: "VIP exclusive", rewardType: "CUSTOM", value: 0, requiredTier: "VIP" });
    if (!created.ok) throw new Error("setup failed");
    const { user } = await userWithPhone();

    const result = await redeemReward(user.id, created.rewardId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("VIP");
  });

  it("rejects redemption of a deactivated reward", async () => {
    const { organizationId } = await orgWithEvent();
    const created = await createReward(organizationId, { name: "Paused", rewardType: "CUSTOM", value: 0, requiredTier: "NEW" });
    if (!created.ok) throw new Error("setup failed");
    await toggleReward(organizationId, created.rewardId, false);
    const { user } = await userWithPhone();

    const result = await redeemReward(user.id, created.rewardId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("no longer available");
  });
});
