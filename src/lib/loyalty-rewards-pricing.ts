import type { LoyaltyTier } from "@/lib/loyalty";

// Session 33 — pure/DB-free helpers behind the loyalty rewards redemption
// layer, same split as resale-pricing.ts/resale.ts: a client component can
// import this file directly (tier progress, value formatting) without
// pulling in Prisma, and loyalty-rewards.ts re-exports everything here
// alongside its DB-touching functions.

export type RewardType = "DISCOUNT_CODE" | "FREE_TICKET" | "WALLET_CREDIT" | "CUSTOM";
export const REWARD_TYPES: RewardType[] = ["DISCOUNT_CODE", "FREE_TICKET", "WALLET_CREDIT", "CUSTOM"];

// Higher number = higher tier. Mirrors the NEW < REPEAT < VIP ordering
// loyaltyTierFromOrdersCount (src/lib/loyalty.ts) already encodes via order
// count thresholds — kept here rather than there since loyalty.ts is the
// existing tier-computation file this session builds on top of, not one to
// modify (see that file's own header comment).
const TIER_RANK: Record<LoyaltyTier, number> = { NEW: 0, REPEAT: 1, VIP: 2 };

export function tierRank(tier: LoyaltyTier): number {
  return TIER_RANK[tier];
}

// A VIP attendee also qualifies for a NEW- or REPEAT-tier reward — the
// requirement is a floor, not an exact match.
export function tierMeetsRequirement(userTier: LoyaltyTier, requiredTier: LoyaltyTier): boolean {
  return tierRank(userTier) >= tierRank(requiredTier);
}

// Order-count thresholds duplicated from loyaltyTierFromOrdersCount's own
// >= 5 / >= 2 cutoffs (src/lib/loyalty.ts) — that function only returns the
// resulting tier, not how far away the next one is, which the attendee
// rewards page needs ("2 more orders to REPEAT"). Kept in sync by the
// shared describe block in loyalty-rewards.test.ts.
const REPEAT_THRESHOLD = 2;
const VIP_THRESHOLD = 5;

export interface TierProgress {
  tier: LoyaltyTier;
  nextTier: LoyaltyTier | null;
  // Orders still needed to reach nextTier — null once nextTier is null (VIP,
  // the top tier, has nothing further to progress toward).
  ordersToNextTier: number | null;
}

export function tierProgress(ordersCount: number): TierProgress {
  if (ordersCount >= VIP_THRESHOLD) return { tier: "VIP", nextTier: null, ordersToNextTier: null };
  if (ordersCount >= REPEAT_THRESHOLD) {
    return { tier: "REPEAT", nextTier: "VIP", ordersToNextTier: VIP_THRESHOLD - ordersCount };
  }
  return { tier: "NEW", nextTier: "REPEAT", ordersToNextTier: REPEAT_THRESHOLD - ordersCount };
}

export type ValueCheck = { ok: true } | { ok: false; error: string };

// value's unit depends on rewardType — see LoyaltyReward's schema comment.
// FREE_TICKET/CUSTOM ignore value entirely (it's unused, always stored as
// whatever the organiser's form leaves it at) so both just require a
// non-negative integer rather than a meaningful range.
export function validateRewardValue(rewardType: RewardType, value: unknown): ValueCheck {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { ok: false, error: "Value must be a whole number." };
  }
  if (rewardType === "DISCOUNT_CODE") {
    if (value < 1 || value > 100) return { ok: false, error: "A discount code reward must be worth 1–100%." };
    return { ok: true };
  }
  if (rewardType === "WALLET_CREDIT") {
    if (value <= 0) return { ok: false, error: "A wallet credit reward must be a positive amount." };
    return { ok: true };
  }
  if (value < 0) return { ok: false, error: "Value can't be negative." };
  return { ok: true };
}

export function rewardIsExpired(reward: { expiresAt: Date | string | null }, now: Date = new Date()): boolean {
  if (!reward.expiresAt) return false;
  return new Date(reward.expiresAt).getTime() <= now.getTime();
}

// stock: null = unlimited.
export function rewardHasStock(reward: { stock: number | null; redeemedCount: number }): boolean {
  return reward.stock === null || reward.redeemedCount < reward.stock;
}

// Every reason a reward can't be redeemed right now, as the message to show
// — shared by redeemReward (enforcement) and getEligibleRewards (what the
// attendee sees), so the rewards page never offers a "Redeem" button the API
// would refuse. alreadyRedeemed is checked separately by the caller (it
// needs a DB lookup this function can't do), so it's passed in rather than
// computed here.
export function rewardBlocker(
  reward: { active: boolean; expiresAt: Date | string | null; stock: number | null; redeemedCount: number; requiredTier: string },
  userTier: LoyaltyTier,
  alreadyRedeemed: boolean,
  now: Date = new Date()
): string | null {
  if (!reward.active) return "This reward is no longer available.";
  if (rewardIsExpired(reward, now)) return "This reward has expired.";
  if (!rewardHasStock(reward)) return "This reward is out of stock.";
  if (!tierMeetsRequirement(userTier, reward.requiredTier as LoyaltyTier)) {
    return `Only available to ${reward.requiredTier} tier and above.`;
  }
  if (alreadyRedeemed) return "You've already redeemed this reward.";
  return null;
}

// What "value" to snapshot on the LoyaltyRedemption row — see that model's
// schema comment. DISCOUNT_CODE/WALLET_CREDIT just echo LoyaltyReward.value
// (percent / cents respectively); FREE_TICKET is the actual face value
// handed over (the ticket type's price at redemption time, not the unused
// reward.value); CUSTOM has nothing to record.
export function redemptionValueFor(rewardType: RewardType, rewardValue: number, ticketTypePriceCents?: number): number {
  if (rewardType === "FREE_TICKET") return ticketTypePriceCents ?? 0;
  if (rewardType === "CUSTOM") return 0;
  return rewardValue;
}
