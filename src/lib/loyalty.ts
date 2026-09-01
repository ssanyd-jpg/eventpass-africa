import { prisma } from "@/lib/prisma";

// Purely computed — no new table, no points/redemption system. Reuses the
// same PAID/NEEDS_REVIEW order-status filter customerStatsByBuyer already
// uses (src/lib/analytics.ts) so a buyer's tier always agrees with what an
// organizer sees on the customer list/detail pages. Order-count-based, not
// spend-based: totalCentsByCurrency is a per-currency map with no single
// number to threshold against, while an order count is currency-agnostic.

export type LoyaltyTier = "NEW" | "REPEAT" | "VIP";

export function loyaltyTierFromOrdersCount(ordersCount: number): LoyaltyTier {
  if (ordersCount >= 5) return "VIP";
  if (ordersCount >= 2) return "REPEAT";
  return "NEW";
}

export interface LoyaltyStatus {
  organizationId: string;
  organizationName: string;
  ordersCount: number;
  lastOrderAt: string;
  tier: LoyaltyTier;
}

// Per-organizer, not platform-wide — "your status with Organizer X," same
// framing customerStatsByBuyer already uses (it has no cross-org
// aggregation anywhere in this codebase; a single platform-wide number
// would be the first one, and a "VIP somewhere" badge that doesn't say
// where would be confusing UX on its own).
export async function getMyLoyaltyStatuses(userId: string): Promise<LoyaltyStatus[]> {
  const orders = await prisma.order.findMany({
    where: { userId, status: { in: ["PAID", "NEEDS_REVIEW"] } },
    select: {
      createdAt: true,
      event: { select: { organizationId: true, organization: { select: { name: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });

  const byOrg = new Map<string, { organizationName: string; ordersCount: number; lastOrderAt: Date }>();
  for (const o of orders) {
    const orgId = o.event.organizationId;
    const existing = byOrg.get(orgId);
    if (existing) {
      existing.ordersCount += 1;
    } else {
      byOrg.set(orgId, {
        organizationName: o.event.organization.name,
        ordersCount: 1,
        lastOrderAt: o.createdAt,
      });
    }
  }

  return Array.from(byOrg.entries())
    .map(([organizationId, v]) => ({
      organizationId,
      organizationName: v.organizationName,
      ordersCount: v.ordersCount,
      lastOrderAt: v.lastOrderAt.toISOString(),
      tier: loyaltyTierFromOrdersCount(v.ordersCount),
    }))
    .sort((a, b) => (a.lastOrderAt < b.lastOrderAt ? 1 : -1));
}
