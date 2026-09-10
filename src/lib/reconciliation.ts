import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/format";
import { buildCsvDocument, centsToMajorUnits, type CsvSection } from "@/lib/csv";

// TZS 5,000 in minor units. A non-zero variance under this is a "minor"
// rounding/change discrepancy; at or over it, the organiser should
// investigate (see the Session 9 spec's amber/red thresholds).
export const MINOR_VARIANCE_THRESHOLD_CENTS = 500_000;

// Unspent wallet balance sitting untouched for this long counts as
// "breakage" — money the organiser is unlikely to ever have to pay out.
export const BREAKAGE_AGE_DAYS = 90;

export type FloatStatus = "BALANCED" | "MINOR_VARIANCE" | "INVESTIGATE";

// system total minus what the operator physically handed in. Positive means
// the operator turned in LESS than the system recorded (a shortfall).
export function computeVariance(systemTotalCents: number, declaredAmountCents: number): number {
  return systemTotalCents - declaredAmountCents;
}

export function classifyVariance(varianceCents: number): FloatStatus {
  if (varianceCents === 0) return "BALANCED";
  if (Math.abs(varianceCents) < MINOR_VARIANCE_THRESHOLD_CENTS) return "MINOR_VARIANCE";
  return "INVESTIGATE";
}

// "Cash collected by staff" has no representation on wallet top-ups (buyer
// self-service, digital only) — it maps to OFFLINE_DEFERRED ticket orders,
// whose Order.userId is the signed-in operator who recorded the door sale.
// PAID and NEEDS_REVIEW both count as real collected cash (NEEDS_REVIEW is
// an oversell flag, not an unpaid state — see handleSellTickets).
function cashOrderWhere(eventId: string, operatorId?: string) {
  return {
    eventId,
    ...(operatorId ? { userId: operatorId } : {}),
    status: { in: ["PAID", "NEEDS_REVIEW"] },
    paymentMethod: "OFFLINE_DEFERRED",
  };
}

export interface OperatorFloat {
  operatorId: string;
  operatorName: string;
  cashTransactionCount: number;
  systemTotalCents: number;
  averageCents: number;
  declaration: {
    declaredAmountCents: number;
    varianceCents: number;
    status: string;
    declaredAt: string;
  } | null;
}

export interface ReconciliationSummary {
  currency: string;
  totalTicketRevenueCents: number; // all payment methods
  digitalTicketRevenueCents: number; // AIRPAY_ONLINE
  cashTicketRevenueCents: number; // OFFLINE_DEFERRED
  unspentWalletBalanceCents: number;
  vendorSalesCents: number;
  netBreakageCents: number; // unspent balance in wallets untouched > 90 days
}

export interface ReconciliationData {
  eventId: string;
  eventTitle: string;
  summary: ReconciliationSummary;
  operators: OperatorFloat[];
  unreconciledOperatorCount: number;
}

// Per-operator computed float for ONE operator, strictly scoped to that
// operatorId's own OFFLINE_DEFERRED orders on this event — the isolation
// the "operator can only see their own float data" test asserts (mirrors
// getVendorDashboardData's per-vendor scoping in Session 8).
export async function getOperatorFloat(eventId: string, operatorId: string): Promise<OperatorFloat | null> {
  const operator = await prisma.user.findUnique({ where: { id: operatorId }, select: { id: true, name: true } });
  if (!operator) return null;

  const orders = await prisma.order.findMany({
    where: cashOrderWhere(eventId, operatorId),
    select: { totalCents: true },
  });
  const declaration = await prisma.floatDeclaration.findUnique({
    where: { eventId_operatorId: { eventId, operatorId } },
  });

  return shapeOperatorFloat(operator, orders, declaration);
}

function shapeOperatorFloat(
  operator: { id: string; name: string },
  orders: { totalCents: number }[],
  declaration: {
    declaredAmountCents: number;
    varianceCents: number;
    status: string;
    declaredAt: Date;
  } | null
): OperatorFloat {
  const systemTotalCents = orders.reduce((sum, o) => sum + o.totalCents, 0);
  const cashTransactionCount = orders.length;
  return {
    operatorId: operator.id,
    operatorName: operator.name,
    cashTransactionCount,
    systemTotalCents,
    averageCents: cashTransactionCount > 0 ? Math.round(systemTotalCents / cashTransactionCount) : 0,
    declaration: declaration
      ? {
          declaredAmountCents: declaration.declaredAmountCents,
          varianceCents: declaration.varianceCents,
          status: declaration.status,
          declaredAt: declaration.declaredAt.toISOString(),
        }
      : null,
  };
}

export async function getReconciliationData(eventId: string, now: Date = new Date()): Promise<ReconciliationData | null> {
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true, title: true, currency: true } });
  if (!event) return null;

  const breakageCutoff = new Date(now.getTime() - BREAKAGE_AGE_DAYS * 24 * 60 * 60 * 1000);

  const [paidOrders, wallets, vendorSales, cashOrders, declarations] = await Promise.all([
    prisma.order.findMany({
      where: { eventId, status: { in: ["PAID", "NEEDS_REVIEW"] } },
      select: { totalCents: true, paymentMethod: true },
    }),
    prisma.wallet.findMany({ where: { eventId }, select: { balanceCents: true, updatedAt: true } }),
    prisma.walletTransaction.aggregate({
      where: { wallet: { eventId }, type: "SALE", status: "COMPLETED" },
      _sum: { amountCents: true },
    }),
    prisma.order.findMany({
      where: cashOrderWhere(eventId),
      select: { totalCents: true, userId: true, user: { select: { id: true, name: true } } },
    }),
    prisma.floatDeclaration.findMany({ where: { eventId } }),
  ]);

  const summary: ReconciliationSummary = {
    currency: event.currency,
    totalTicketRevenueCents: paidOrders.reduce((s, o) => s + o.totalCents, 0),
    digitalTicketRevenueCents: paidOrders
      .filter((o) => o.paymentMethod === "AIRPAY_ONLINE")
      .reduce((s, o) => s + o.totalCents, 0),
    cashTicketRevenueCents: paidOrders
      .filter((o) => o.paymentMethod === "OFFLINE_DEFERRED")
      .reduce((s, o) => s + o.totalCents, 0),
    unspentWalletBalanceCents: wallets.reduce((s, w) => s + w.balanceCents, 0),
    vendorSalesCents: vendorSales._sum.amountCents ?? 0,
    netBreakageCents: wallets
      .filter((w) => w.balanceCents > 0 && w.updatedAt < breakageCutoff)
      .reduce((s, w) => s + w.balanceCents, 0),
  };

  const declarationByOperator = new Map(declarations.map((d) => [d.operatorId, d]));
  const ordersByOperator = new Map<string, { operator: { id: string; name: string }; orders: { totalCents: number }[] }>();
  for (const o of cashOrders) {
    const entry = ordersByOperator.get(o.userId) ?? { operator: o.user, orders: [] };
    entry.orders.push({ totalCents: o.totalCents });
    ordersByOperator.set(o.userId, entry);
  }

  const operators = Array.from(ordersByOperator.values())
    .map(({ operator, orders }) => shapeOperatorFloat(operator, orders, declarationByOperator.get(operator.id) ?? null))
    .sort((a, b) => b.systemTotalCents - a.systemTotalCents);

  return {
    eventId: event.id,
    eventTitle: event.title,
    summary,
    operators,
    unreconciledOperatorCount: operators.filter((o) => o.declaration === null).length,
  };
}

// Idempotent: re-declaring for the same operator/event updates the same
// row. The system total and variance are always recomputed here, never
// trusted from the caller — the declared physical amount is the only
// client-supplied number.
export async function saveFloatDeclarationCore(params: {
  eventId: string;
  operatorId: string;
  declaredAmountCents: number;
  declaredByUserId: string;
}): Promise<{ systemTotalCents: number; varianceCents: number; status: FloatStatus }> {
  const orders = await prisma.order.findMany({
    where: cashOrderWhere(params.eventId, params.operatorId),
    select: { totalCents: true },
  });
  const systemTotalCents = orders.reduce((sum, o) => sum + o.totalCents, 0);
  const varianceCents = computeVariance(systemTotalCents, params.declaredAmountCents);
  const status = classifyVariance(varianceCents);

  await prisma.floatDeclaration.upsert({
    where: { eventId_operatorId: { eventId: params.eventId, operatorId: params.operatorId } },
    create: {
      eventId: params.eventId,
      operatorId: params.operatorId,
      declaredAmountCents: params.declaredAmountCents,
      varianceCents,
      status,
      declaredByUserId: params.declaredByUserId,
    },
    update: {
      declaredAmountCents: params.declaredAmountCents,
      varianceCents,
      status,
      declaredByUserId: params.declaredByUserId,
      declaredAt: new Date(),
    },
  });

  return { systemTotalCents, varianceCents, status };
}

// CSV sections for the full reconciliation, extracted from the export route
// so the "correct headers and row count" test can assert against it
// directly — same split as buildOrderConfirmationHtml being testable apart
// from its caller.
export function buildReconciliationCsvSections(data: ReconciliationData): CsvSection[] {
  const c = data.summary.currency;
  return [
    {
      title: `Reconciliation — ${data.eventTitle}`,
      headers: ["Metric", "Amount (Major Units)", "Amount (Formatted)"],
      rows: [
        ["Total ticket revenue (all methods)", centsToMajorUnits(data.summary.totalTicketRevenueCents), formatCents(data.summary.totalTicketRevenueCents, c)],
        ["Digital ticket revenue (AirPay)", centsToMajorUnits(data.summary.digitalTicketRevenueCents), formatCents(data.summary.digitalTicketRevenueCents, c)],
        ["Cash ticket revenue (OFFLINE_DEFERRED)", centsToMajorUnits(data.summary.cashTicketRevenueCents), formatCents(data.summary.cashTicketRevenueCents, c)],
        ["Unspent wallet balance", centsToMajorUnits(data.summary.unspentWalletBalanceCents), formatCents(data.summary.unspentWalletBalanceCents, c)],
        ["Vendor sales", centsToMajorUnits(data.summary.vendorSalesCents), formatCents(data.summary.vendorSalesCents, c)],
        [`Net breakage (unspent > ${BREAKAGE_AGE_DAYS} days)`, centsToMajorUnits(data.summary.netBreakageCents), formatCents(data.summary.netBreakageCents, c)],
      ],
    },
    {
      title: "Per-operator cash float",
      headers: [
        "Operator",
        "Operator ID",
        "Cash transactions",
        "System total (Major Units)",
        "Average top-up (Major Units)",
        "Declared float (Major Units)",
        "Variance (Major Units)",
        "Status",
      ],
      rows: data.operators.map((op) => [
        op.operatorName,
        op.operatorId,
        op.cashTransactionCount,
        centsToMajorUnits(op.systemTotalCents),
        centsToMajorUnits(op.averageCents),
        op.declaration ? centsToMajorUnits(op.declaration.declaredAmountCents) : "",
        op.declaration ? centsToMajorUnits(op.declaration.varianceCents) : "",
        op.declaration ? op.declaration.status : "NOT DECLARED",
      ]),
    },
  ];
}

export function buildReconciliationCsv(data: ReconciliationData): string {
  return buildCsvDocument(buildReconciliationCsvSections(data));
}
