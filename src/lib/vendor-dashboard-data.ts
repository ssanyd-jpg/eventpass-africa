import { prisma } from "@/lib/prisma";
import { transactionsByVendorByHour } from "@/lib/analytics";
import { buildCsvDocument, type CsvSection } from "@/lib/csv";

// Split out of the route handler so it's directly testable without going
// through auth()/NextAuth request plumbing — same reasoning
// getLiveEventData (src/lib/analytics-data.ts) is split from its own route.
// Everything here is already scoped to the ONE vendorId passed in; the
// caller (the API route) is responsible for verifying the requesting
// session is actually allowed to see that vendorId before calling this.
export async function getVendorDashboardData(vendorId: string, now: Date = new Date()) {
  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    include: { event: { select: { title: true, currency: true, startsAt: true, eventType: true } } },
  });
  if (!vendor) return null;

  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const todaysTxs = await prisma.walletTransaction.findMany({
    where: { vendorId: vendor.id, type: "SALE", createdAt: { gte: todayStart } },
    select: { id: true, amountCents: true, item: true, status: true, createdAt: true, wallet: { select: { code: true } } },
    orderBy: { createdAt: "desc" },
  });
  const completedToday = todaysTxs.filter((t) => t.status === "COMPLETED");

  const todaysSalesTotalCents = completedToday.reduce((sum, t) => sum + (t.amountCents ?? 0), 0);
  const transactionCount = completedToday.length;
  const averageTransactionCents = transactionCount > 0 ? Math.round(todaysSalesTotalCents / transactionCount) : 0;

  // Reuses the same hourly-bucketing analytics function the organiser live
  // monitoring page uses (see transactionsByVendorByHour in
  // src/lib/analytics.ts) — passing todayStart as its "event start" bound
  // gives today-only hours regardless of how long ago the event itself
  // started, which is what a vendor checking "how's today going" wants,
  // not the whole multi-day event's range.
  const hourly = transactionsByVendorByHour(
    completedToday.map((t) => ({
      type: "SALE",
      status: "COMPLETED",
      amountCents: t.amountCents,
      createdAt: t.createdAt,
      vendor: { id: vendor.id, name: vendor.name },
    })),
    todayStart,
    now
  )[0] ?? { vendorName: vendor.name, hours: [] };

  const itemTotals = new Map<string, number>();
  for (const t of completedToday) {
    const key = t.item?.trim() || "Unspecified";
    itemTotals.set(key, (itemTotals.get(key) ?? 0) + (t.amountCents ?? 0));
  }
  const topItems = Array.from(itemTotals.entries())
    .map(([item, amountCents]) => ({ item, amountCents }))
    .sort((a, b) => b.amountCents - a.amountCents)
    .slice(0, 5);

  // Settlement "amount" is the frozen payout figure once SETTLED (see the
  // Vendor.settlementAmountCents comment in prisma/schema.prisma); while
  // still PENDING/PROCESSING there's no frozen figure yet, so this shows
  // the live all-time completed-sales total instead — what they'd currently
  // be owed if settled right now.
  let settlementAmountCents = vendor.settlementAmountCents;
  if (vendor.settlementStatus !== "SETTLED") {
    const totals = await prisma.walletTransaction.aggregate({
      where: { vendorId: vendor.id, type: "SALE", status: "COMPLETED" },
      _sum: { amountCents: true },
    });
    settlementAmountCents = totals._sum.amountCents ?? 0;
  }

  // Session 19 — CONFERENCE-only "My leads" section: this exhibitor's own
  // captured leads, most recent first. Fetched unconditionally (cheap — a
  // vendor at a non-CONFERENCE event simply has none) rather than branching
  // on eventType here; the page itself decides whether to render the
  // section, same "exists on every event, only shown when relevant"
  // convention timingPoints/conferenceSessions use elsewhere.
  const leads = await prisma.exhibitorLead.findMany({
    where: { vendorId: vendor.id },
    include: {
      credential: { include: { ticket: { include: { order: { select: { user: { select: { name: true } } } } } } } },
    },
    orderBy: { capturedAt: "desc" },
  });

  return {
    vendorName: vendor.name,
    eventTitle: vendor.event.title,
    eventType: vendor.event.eventType,
    currency: vendor.event.currency,
    lastUpdated: now.toISOString(),
    stats: { todaysSalesTotalCents, transactionCount, averageTransactionCents },
    salesByHour: hourly.hours,
    topItems,
    settlement: {
      status: vendor.settlementStatus,
      amountCents: settlementAmountCents,
      processedAt: vendor.settlementProcessedAt ? vendor.settlementProcessedAt.toISOString() : null,
    },
    transactions: todaysTxs.map((t) => ({
      id: t.id,
      createdAt: t.createdAt.toISOString(),
      item: t.item,
      amountCents: t.amountCents,
      status: t.status,
      walletCodeLast4: t.wallet.code.slice(-4),
    })),
    leads: leads.map((l) => ({
      id: l.id,
      capturedAt: l.capturedAt.toISOString(),
      attendeeName: l.credential.ticket?.order.user.name ?? "Unknown attendee",
      notes: l.notes,
    })),
  };
}

export interface ExhibitorLeadExportRow {
  capturedAt: string;
  attendeeName: string;
  notes: string | null;
}

// CSV export of this exhibitor's own leads (point 4) — same hand-rolled csv.ts
// pattern every other export in this app uses.
export function buildExhibitorLeadsCsv(vendorName: string, rows: ExhibitorLeadExportRow[]): string {
  const sections: CsvSection[] = [
    {
      title: `Leads — ${vendorName}`,
      headers: ["Time", "Attendee", "Notes"],
      rows: rows.map((r) => [new Date(r.capturedAt).toLocaleString(), r.attendeeName, r.notes ?? ""]),
    },
  ];
  return buildCsvDocument(sections);
}

export async function getExhibitorLeadsExportData(vendorId: string): Promise<{ vendorName: string; rows: ExhibitorLeadExportRow[] } | null> {
  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { name: true } });
  if (!vendor) return null;

  const leads = await prisma.exhibitorLead.findMany({
    where: { vendorId },
    include: {
      credential: { include: { ticket: { include: { order: { select: { user: { select: { name: true } } } } } } } },
    },
    orderBy: { capturedAt: "desc" },
  });

  return {
    vendorName: vendor.name,
    rows: leads.map((l) => ({
      capturedAt: l.capturedAt.toISOString(),
      attendeeName: l.credential.ticket?.order.user.name ?? "Unknown attendee",
      notes: l.notes,
    })),
  };
}
