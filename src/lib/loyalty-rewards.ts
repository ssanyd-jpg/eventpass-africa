import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/notifications";
import { formatCents, generateTicketCode } from "@/lib/format";
import { getMyLoyaltyStatuses, loyaltyTierFromOrdersCount, type LoyaltyTier } from "@/lib/loyalty";
import type { RankedEntry } from "@/lib/analytics";
import {
  REWARD_TYPES,
  type RewardType,
  tierRank,
  tierMeetsRequirement,
  tierProgress,
  validateRewardValue,
  rewardIsExpired,
  rewardHasStock,
  rewardBlocker,
  redemptionValueFor,
} from "@/lib/loyalty-rewards-pricing";

export {
  REWARD_TYPES,
  tierRank,
  tierMeetsRequirement,
  tierProgress,
  validateRewardValue,
  rewardIsExpired,
  rewardHasStock,
  rewardBlocker,
  redemptionValueFor,
};
export type { RewardType, TierProgress, ValueCheck } from "@/lib/loyalty-rewards-pricing";

// Session 33 — loyalty rewards redemption, built on top of the tier system
// in src/lib/loyalty.ts (NEW | REPEAT | VIP, purely from order count with
// one organiser — see that file's header comment; not modified here). This
// file is the DB-touching half — same createListing/resale.ts split as
// every other feature in this codebase, tested directly without HTTP/
// session plumbing.

async function whatsappTo(userId: string, subject: string, body: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { phone: true } });
  if (!user?.phone) return;
  await sendNotification({ type: "LOYALTY_REWARD", channel: "WHATSAPP", recipient: user.phone, subject, body });
}

// This user's tier + order count with one specific organisation — a thin
// wrapper over getMyLoyaltyStatuses (which returns one entry per org the
// buyer has ever ordered from), defaulting to NEW/0 for an org they've never
// bought from at all (same as loyaltyTierFromOrdersCount(0)).
async function myTierForOrg(userId: string, organizationId: string): Promise<{ tier: LoyaltyTier; ordersCount: number }> {
  const statuses = await getMyLoyaltyStatuses(userId);
  const status = statuses.find((s) => s.organizationId === organizationId);
  return status ? { tier: status.tier, ordersCount: status.ordersCount } : { tier: loyaltyTierFromOrdersCount(0), ordersCount: 0 };
}

export interface CreateRewardInput {
  name: string;
  description?: string;
  rewardType: RewardType;
  value: number;
  requiredTier: LoyaltyTier;
  stock?: number | null;
  expiresAt?: Date | null;
  // Required for DISCOUNT_CODE/FREE_TICKET (which event's ticket type the
  // reward draws from); ignored (stored null) for WALLET_CREDIT/CUSTOM.
  eventId?: string | null;
  ticketTypeId?: string | null;
}

export async function createReward(organizationId: string, input: CreateRewardInput) {
  const name = input.name.trim();
  if (!name) return { ok: false as const, error: "Name is required." };
  if (!REWARD_TYPES.includes(input.rewardType)) return { ok: false as const, error: "Invalid reward type." };
  if (!["NEW", "REPEAT", "VIP"].includes(input.requiredTier)) return { ok: false as const, error: "Invalid required tier." };

  const valueCheck = validateRewardValue(input.rewardType, input.value);
  if (!valueCheck.ok) return { ok: false as const, error: valueCheck.error };

  if (input.stock !== undefined && input.stock !== null && (!Number.isInteger(input.stock) || input.stock <= 0)) {
    return { ok: false as const, error: "Stock must be a positive whole number, or left blank for unlimited." };
  }

  const needsTicketType = input.rewardType === "DISCOUNT_CODE" || input.rewardType === "FREE_TICKET";
  let eventId: string | null = null;
  let ticketTypeId: string | null = null;

  if (needsTicketType) {
    if (!input.eventId || !input.ticketTypeId) {
      return { ok: false as const, error: `A ${input.rewardType === "DISCOUNT_CODE" ? "discount code" : "free ticket"} reward needs an event and ticket type.` };
    }
    const ticketType = await prisma.ticketType.findUnique({
      where: { id: input.ticketTypeId },
      select: { id: true, eventId: true, event: { select: { organizationId: true } } },
    });
    if (!ticketType || ticketType.eventId !== input.eventId || ticketType.event.organizationId !== organizationId) {
      return { ok: false as const, error: "That ticket type doesn't belong to your organisation's event." };
    }
    eventId = input.eventId;
    ticketTypeId = input.ticketTypeId;
  }

  const reward = await prisma.loyaltyReward.create({
    data: {
      organizationId,
      name,
      description: input.description?.trim() ?? "",
      rewardType: input.rewardType,
      value: input.value,
      requiredTier: input.requiredTier,
      stock: input.stock ?? null,
      expiresAt: input.expiresAt ?? null,
      eventId,
      ticketTypeId,
    },
  });

  return { ok: true as const, rewardId: reward.id };
}

export interface RewardListItem {
  id: string;
  name: string;
  description: string;
  rewardType: RewardType;
  value: number;
  requiredTier: LoyaltyTier;
  stock: number | null;
  redeemedCount: number;
  active: boolean;
  expiresAt: string | null;
  createdAt: string;
  eventTitle: string | null;
  ticketTypeName: string | null;
}

export async function listRewards(organizationId: string): Promise<RewardListItem[]> {
  const rewards = await prisma.loyaltyReward.findMany({
    where: { organizationId },
    include: { event: { select: { title: true } }, ticketType: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  return rewards.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    rewardType: r.rewardType as RewardType,
    value: r.value,
    requiredTier: r.requiredTier as LoyaltyTier,
    stock: r.stock,
    redeemedCount: r.redeemedCount,
    active: r.active,
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    eventTitle: r.event?.title ?? null,
    ticketTypeName: r.ticketType?.name ?? null,
  }));
}

export async function toggleReward(organizationId: string, rewardId: string, active: boolean) {
  const res = await prisma.loyaltyReward.updateMany({
    where: { id: rewardId, organizationId },
    data: { active },
  });
  if (res.count === 0) return { ok: false as const, error: "Reward not found." };
  return { ok: true as const };
}

export interface EligibleReward {
  id: string;
  name: string;
  description: string;
  rewardType: RewardType;
  value: number;
  requiredTier: LoyaltyTier;
  expiresAt: string | null;
  eventTitle: string | null;
  alreadyRedeemed: boolean;
  // Non-null = can't be redeemed right now, and why. The page shows a
  // disabled button with this text instead of hiding the reward outright —
  // same "never offer a button the API would refuse" discipline as
  // getTicketResaleState in resale.ts.
  blocker: string | null;
}

export interface EligibleRewardsResult {
  tier: LoyaltyTier;
  ordersCount: number;
  progress: ReturnType<typeof tierProgress>;
  rewards: EligibleReward[];
}

export async function getEligibleRewards(userId: string, organizationId: string, now: Date = new Date()): Promise<EligibleRewardsResult> {
  const { tier, ordersCount } = await myTierForOrg(userId, organizationId);

  const rewards = await prisma.loyaltyReward.findMany({
    where: { organizationId, active: true },
    include: { event: { select: { title: true } } },
    orderBy: { createdAt: "desc" },
  });
  const eligible = rewards.filter((r) => tierMeetsRequirement(tier, r.requiredTier as LoyaltyTier));

  const myRedemptions = await prisma.loyaltyRedemption.findMany({
    where: { userId, rewardId: { in: eligible.map((r) => r.id) } },
    select: { rewardId: true },
  });
  const redeemedSet = new Set(myRedemptions.map((r) => r.rewardId));

  return {
    tier,
    ordersCount,
    progress: tierProgress(ordersCount),
    rewards: eligible.map((r) => {
      const alreadyRedeemed = redeemedSet.has(r.id);
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        rewardType: r.rewardType as RewardType,
        value: r.value,
        requiredTier: r.requiredTier as LoyaltyTier,
        expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
        eventTitle: r.event?.title ?? null,
        alreadyRedeemed,
        blocker: rewardBlocker(r, tier, alreadyRedeemed, now),
      };
    }),
  };
}

class RedeemFailed extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}

// Redeems one reward for one attendee — stock/expiry/tier/one-per-user are
// all re-checked here regardless of what getEligibleRewards showed the page
// (that's display-only; this is the enforcement). Everything — the stock
// CAS, the delivery (DiscountCode/Wallet+WalletTransaction/Order+Ticket),
// and the LoyaltyRedemption row itself — happens in one transaction, so a
// reward can never be "spent" (redeemedCount incremented, a code/credit/
// ticket created) without the redemption record that proves it, or the
// reverse. eventId is optional context for WALLET_CREDIT (which event's
// wallet to credit, when the attendee has more than one LIVE one with this
// organiser) and for CUSTOM's redemption record; DISCOUNT_CODE/FREE_TICKET
// always use the reward's own eventId, set once at creation.
export async function redeemReward(userId: string, rewardId: string, eventId?: string, now: Date = new Date()) {
  const reward = await prisma.loyaltyReward.findUnique({
    where: { id: rewardId },
    include: {
      event: { select: { id: true, title: true, slug: true, currency: true, organizationId: true } },
      ticketType: { select: { id: true, name: true, priceCents: true, quantityTotal: true, quantitySold: true } },
    },
  });
  if (!reward) return { ok: false as const, error: "Reward not found." };

  const { tier } = await myTierForOrg(userId, reward.organizationId);
  const existing = await prisma.loyaltyRedemption.findUnique({
    where: { rewardId_userId: { rewardId, userId } },
  });
  const blocker = rewardBlocker(reward, tier, !!existing, now);
  if (blocker) return { ok: false as const, error: blocker };

  try {
    const result = await prisma.$transaction(async (tx) => {
      // CAS the stock (and re-check active — a race with an organiser
      // deactivating it right now loses here too) before delivering anything.
      const claimed = await tx.loyaltyReward.updateMany({
        where: {
          id: rewardId,
          active: true,
          OR: [{ stock: null }, { redeemedCount: { lt: reward.stock ?? 0 } }],
        },
        data: { redeemedCount: { increment: 1 } },
      });
      if (claimed.count === 0) throw new RedeemFailed("This reward is no longer available.");

      let discountCodeId: string | null = null;
      let walletTransactionId: string | null = null;
      let ticketId: string | null = null;
      let redemptionEventId: string | null = eventId ?? null;

      if (reward.rewardType === "DISCOUNT_CODE") {
        if (!reward.event || !reward.ticketType) throw new RedeemFailed("This reward isn't fully configured.");
        let code: { id: string } | null = null;
        for (let attempt = 0; attempt < 5 && !code; attempt++) {
          try {
            code = await tx.discountCode.create({
              data: {
                eventId: reward.event.id,
                ticketTypeId: reward.ticketType.id,
                code: `LOY-${generateTicketCode()}`,
                type: "PERCENT_OFF",
                percentOff: reward.value,
                maxRedemptions: 1,
                active: true,
                loyaltyRewardId: reward.id,
              },
              select: { id: true },
            });
          } catch (err) {
            if ((err as { code?: string }).code !== "P2002") throw err;
          }
        }
        if (!code) throw new RedeemFailed("Couldn't generate a unique code — try again.");
        discountCodeId = code.id;
        redemptionEventId = reward.event.id;
      } else if (reward.rewardType === "WALLET_CREDIT") {
        let wallet = eventId
          ? await tx.wallet.findUnique({
              where: { eventId_ownerUserId: { eventId, ownerUserId: userId } },
              include: { event: { select: { organizationId: true, status: true } } },
            })
          : null;
        if (wallet && (wallet.event.organizationId !== reward.organizationId || wallet.event.status !== "LIVE")) wallet = null;
        if (!wallet) {
          wallet = await tx.wallet.findFirst({
            where: { ownerUserId: userId, event: { organizationId: reward.organizationId, status: "LIVE" } },
            orderBy: { event: { startsAt: "asc" } },
            include: { event: { select: { organizationId: true, status: true } } },
          });
        }
        if (!wallet) throw new RedeemFailed("You don't have an active wallet for this organiser's events yet.");

        await tx.wallet.update({ where: { id: wallet.id }, data: { balanceCents: { increment: reward.value } } });
        const walletTx = await tx.walletTransaction.create({
          data: {
            type: "LOYALTY_CREDIT",
            status: "COMPLETED",
            amountCents: reward.value,
            currency: wallet.currency,
            walletId: wallet.id,
            providerMessage: `Loyalty reward: ${reward.name}`,
          },
          select: { id: true },
        });
        walletTransactionId = walletTx.id;
      } else if (reward.rewardType === "FREE_TICKET") {
        if (!reward.event || !reward.ticketType) throw new RedeemFailed("This reward isn't fully configured.");
        const claimedTicket = await tx.ticketType.updateMany({
          where: { id: reward.ticketType.id, quantitySold: { lt: reward.ticketType.quantityTotal } },
          data: { quantitySold: { increment: 1 } },
        });
        if (claimedTicket.count === 0) throw new RedeemFailed("This ticket type is sold out.");

        const order = await tx.order.create({
          data: {
            status: "PAID",
            totalCents: 0,
            currency: reward.event.currency,
            userId,
            eventId: reward.event.id,
            items: { create: [{ ticketTypeId: reward.ticketType.id, quantity: 1, unitPriceCents: 0 }] },
            tickets: { create: [{ code: generateTicketCode(), eventId: reward.event.id, ticketTypeId: reward.ticketType.id }] },
          },
          include: { tickets: { select: { id: true, code: true } } },
        });
        ticketId = order.tickets[0].id;
        redemptionEventId = reward.event.id;
      }
      // CUSTOM delivers nothing beyond the WhatsApp sent after commit.

      const value = redemptionValueFor(reward.rewardType as RewardType, reward.value, reward.ticketType?.priceCents);
      const redemption = await tx.loyaltyRedemption.create({
        data: {
          rewardId,
          userId,
          eventId: redemptionEventId,
          value,
          tier,
          discountCodeId,
          walletTransactionId,
          ticketId,
        },
      });

      return { redemptionId: redemption.id, discountCodeId, walletTransactionId, ticketId, value };
    }, { timeout: 15000, maxWait: 10000 });

    await notifyRedemption(userId, reward, result);
    return { ok: true as const, ...result };
  } catch (err) {
    if (err instanceof RedeemFailed) return { ok: false as const, error: err.message };
    // The unique (rewardId, userId) constraint is the race-safe backstop
    // behind the upfront `existing` check above — two concurrent redeems
    // for the same reward+user can't both create a row.
    if ((err as { code?: string }).code === "P2002") return { ok: false as const, error: "You've already redeemed this reward." };
    throw err;
  }
}

async function notifyRedemption(
  userId: string,
  reward: { rewardType: string; name: string; description: string; value: number; event: { title: string; slug: string; currency: string } | null; ticketType: { name: string } | null },
  result: { discountCodeId: string | null; walletTransactionId: string | null; ticketId: string | null; value: number }
) {
  const link = (path: string) => `${process.env.NEXTAUTH_URL ?? ""}${path}`;

  if (reward.rewardType === "DISCOUNT_CODE" && result.discountCodeId) {
    const code = await prisma.discountCode.findUnique({ where: { id: result.discountCodeId }, select: { code: true } });
    await whatsappTo(
      userId,
      "Loyalty reward redeemed",
      `🎁 You've redeemed "${reward.name}"! Your code is ${code?.code} — ${reward.value}% off a ${reward.ticketType?.name ?? "ticket"} for ${reward.event?.title}. One-time use.`
    );
  } else if (reward.rewardType === "WALLET_CREDIT" && reward.event) {
    await whatsappTo(
      userId,
      "Loyalty reward redeemed",
      `🎁 You've redeemed "${reward.name}"! ${formatCents(result.value, reward.event.currency)} has been added to your wallet.`
    );
  } else if (reward.rewardType === "FREE_TICKET" && result.ticketId && reward.event) {
    const ticket = await prisma.ticket.findUnique({ where: { id: result.ticketId }, select: { code: true } });
    await whatsappTo(
      userId,
      "Loyalty reward redeemed",
      `🎁 You've redeemed "${reward.name}"! Your free ${reward.ticketType?.name ?? "ticket"} for ${reward.event.title} is ready — code ${ticket?.code}. View it: ${link(`/account/tickets/${result.ticketId}`)}`
    );
  } else if (reward.rewardType === "CUSTOM") {
    await whatsappTo(userId, "Loyalty reward redeemed", `🎁 You've redeemed "${reward.name}"! ${reward.description}`.trim());
  }
}

export interface RedemptionExportRow {
  rewardName: string;
  rewardType: RewardType;
  userName: string;
  userEmail: string;
  tier: LoyaltyTier;
  value: number;
  eventTitle: string | null;
  redeemedAt: string;
}

export async function listRedemptionsForExport(organizationId: string): Promise<RedemptionExportRow[]> {
  const redemptions = await prisma.loyaltyRedemption.findMany({
    where: { reward: { organizationId } },
    include: {
      reward: { select: { name: true, rewardType: true } },
      user: { select: { name: true, email: true } },
      event: { select: { title: true } },
    },
    orderBy: { redeemedAt: "desc" },
  });
  return redemptions.map((r) => ({
    rewardName: r.reward.name,
    rewardType: r.reward.rewardType as RewardType,
    userName: r.user.name,
    userEmail: r.user.email,
    tier: r.tier as LoyaltyTier,
    value: r.value,
    eventTitle: r.event?.title ?? null,
    redeemedAt: r.redeemedAt.toISOString(),
  }));
}

export interface OrganizerRedemptionRow {
  rewardId: string;
  rewardName: string;
  tier: LoyaltyTier;
}

export async function getOrganizerRedemptions(organizationId: string): Promise<OrganizerRedemptionRow[]> {
  const redemptions = await prisma.loyaltyRedemption.findMany({
    where: { reward: { organizationId } },
    select: { rewardId: true, tier: true, reward: { select: { name: true } } },
  });
  return redemptions.map((r) => ({ rewardId: r.rewardId, rewardName: r.reward.name, tier: r.tier as LoyaltyTier }));
}

// Redemptions by tier — a plain count, no currency involved.
export function summarizeRedemptionsByTier(redemptions: { tier: string }[]): Record<LoyaltyTier, number> {
  const byTier: Record<LoyaltyTier, number> = { NEW: 0, REPEAT: 0, VIP: 0 };
  for (const r of redemptions) {
    if (r.tier === "NEW" || r.tier === "REPEAT" || r.tier === "VIP") byTier[r.tier] += 1;
  }
  return byTier;
}

export function mostPopularRewards(redemptions: OrganizerRedemptionRow[], limit = 5): RankedEntry[] {
  const totals = new Map<string, RankedEntry>();
  for (const r of redemptions) {
    const entry = totals.get(r.rewardId) ?? { label: r.rewardName, value: 0 };
    entry.value += 1;
    totals.set(r.rewardId, entry);
  }
  return Array.from(totals.values())
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

// Loyalty-driven revenue — orders paid for with a discount code that came
// from a loyalty reward (DiscountCode.loyaltyRewardId set — see the
// schema comment on that column). Same PAID/NEEDS_REVIEW allowlist and
// per-currency-map shape as every other revenue figure in analytics.ts.
export async function getLoyaltyDrivenRevenue(organizationId: string): Promise<Record<string, number>> {
  const orders = await prisma.order.findMany({
    where: {
      event: { organizationId },
      status: { in: ["PAID", "NEEDS_REVIEW"] },
      discountCode: { loyaltyRewardId: { not: null } },
    },
    select: { totalCents: true, currency: true },
  });
  const byCurrency: Record<string, number> = {};
  for (const o of orders) byCurrency[o.currency] = (byCurrency[o.currency] ?? 0) + o.totalCents;
  return byCurrency;
}
