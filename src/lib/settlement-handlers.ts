import { prisma } from "@/lib/prisma";

const PLATFORM_FEE_RATE = 0.08;

function shapeSettlement(s: {
  id: string;
  organizerId: string;
  mobileMoneyAccountId: string;
  periodStart: Date;
  periodEnd: Date;
  currency: string;
  grossCents: number;
  platformFeeCents: number;
  netCents: number;
  status: string;
  payoutReference: string | null;
  createdAt: Date;
  paidAt: Date | null;
}) {
  return {
    id: s.id,
    organizerId: s.organizerId,
    mobileMoneyAccountId: s.mobileMoneyAccountId,
    periodStart: s.periodStart.toISOString(),
    periodEnd: s.periodEnd.toISOString(),
    currency: s.currency,
    grossCents: s.grossCents,
    platformFeeCents: s.platformFeeCents,
    netCents: s.netCents,
    status: s.status,
    payoutReference: s.payoutReference,
    createdAt: s.createdAt.toISOString(),
    paidAt: s.paidAt?.toISOString() ?? null,
  };
}

// Extracted from POST /api/settlements/run for the same reason as
// sync-handlers.ts — testable without HTTP/session plumbing.
//
// An organizer can run events in more than one currency, so unsettled
// orders are grouped by currency and settled independently — summing
// across currencies into one total would silently produce a meaningless
// number. Each currency group becomes its own Settlement record, all
// created in this one call.
export async function runSettlement(userId: string, mobileMoneyAccountId?: string) {
  const account = mobileMoneyAccountId
    ? await prisma.mobileMoneyAccount.findFirst({
        where: { id: mobileMoneyAccountId, organizerId: userId },
      })
    : await prisma.mobileMoneyAccount.findFirst({
        where: { organizerId: userId },
        orderBy: { isDefault: "desc" },
      });

  if (!account) {
    return { ok: false as const, reason: "NO_MOBILE_MONEY_ACCOUNT" };
  }

  const myEvents = await prisma.event.findMany({
    where: { organizerId: userId },
    select: { id: true },
  });
  const eventIds = myEvents.map((e) => e.id);

  const alreadySettledOrderIds = (
    await prisma.settlementItem.findMany({
      where: { order: { eventId: { in: eventIds } } },
      select: { orderId: true },
    })
  ).map((s) => s.orderId);

  const unsettledOrders = await prisma.order.findMany({
    where: {
      eventId: { in: eventIds },
      status: { in: ["PAID", "NEEDS_REVIEW"] },
      id: { notIn: alreadySettledOrderIds },
    },
  });

  if (unsettledOrders.length === 0) {
    return { ok: false as const, reason: "NOTHING_TO_SETTLE" };
  }

  const ordersByCurrency = new Map<string, typeof unsettledOrders>();
  for (const order of unsettledOrders) {
    const group = ordersByCurrency.get(order.currency) ?? [];
    group.push(order);
    ordersByCurrency.set(order.currency, group);
  }

  const now = new Date();
  const settlements = [];

  for (const [currency, orders] of Array.from(ordersByCurrency)) {
    const grossCents = orders.reduce((sum, o) => sum + o.totalCents, 0);
    const platformFeeCents = Math.round(grossCents * PLATFORM_FEE_RATE);
    const netCents = grossCents - platformFeeCents;
    const periodStart = orders.reduce(
      (min, o) => (o.createdAt < min ? o.createdAt : min),
      orders[0].createdAt
    );
    const payoutReference = `SIM-${account.provider}-${currency}-${now.getTime().toString(36).toUpperCase()}`;

    const settlement = await prisma.settlement.create({
      data: {
        organizerId: userId,
        mobileMoneyAccountId: account.id,
        periodStart,
        periodEnd: now,
        currency,
        grossCents,
        platformFeeCents,
        netCents,
        status: "PAID_OUT",
        payoutReference,
        paidAt: now,
        items: {
          create: orders.map((o) => ({
            orderId: o.id,
            amountCents: o.totalCents,
          })),
        },
      },
    });

    settlements.push(shapeSettlement(settlement));
  }

  return {
    ok: true as const,
    settlements,
    ordersSettled: unsettledOrders.length,
  };
}
