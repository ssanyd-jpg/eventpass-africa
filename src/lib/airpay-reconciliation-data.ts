import { prisma } from "@/lib/prisma";
import { buildCsvDocument, centsToMajorUnits, type CsvSection } from "@/lib/csv";
import {
  summarizeAirpayReconciliation,
  labelForMethod,
  type AirpayReconciliationSummary,
  type TopupRecord,
} from "@/lib/airpay-reconciliation";

// AirPay reconciliation is financial data — unlike every other event
// dashboard report (forecast, cash reconciliation, analytics), which is
// open to any org member except GATE_CREW, this one is OWNER only. Pulled
// into a named function so "STAFF blocked" / "GATE_CREW blocked" are each
// one testable thing, matching canAccessForecast's own convention in
// revenue-forecast-data.ts.
export function canAccessAirpayReconciliation(organizationRole: string | undefined): boolean {
  return organizationRole === "OWNER";
}

export interface AirpayReconciliationPageData {
  eventId: string;
  eventTitle: string;
  summary: AirpayReconciliationSummary;
}

function topupWhere(eventId: string) {
  return { wallet: { eventId }, type: "TOPUP", status: "COMPLETED" } as const;
}

// Session 28 — Direct Sale's own confirmed-money filter, same status
// discipline as topupWhere: only a settled charge counts as reconcilable
// AirPay revenue, never a PENDING/FAILED/CANCELLED attempt.
function directSaleWhere(eventId: string) {
  return { eventId, status: "CONFIRMED" } as const;
}

// Last 4 digits visible, same masking discipline as the wallet code's own
// `•••${code.slice(-4)}` — a Direct Sale row has no wallet code to show, the
// customer's phone number is the closest analogous "which record is this"
// identifier, and it's just as sensitive.
function maskPhone(phone: string): string {
  return `•••${phone.slice(-4)}`;
}

export async function getAirpayReconciliationData(eventId: string): Promise<AirpayReconciliationPageData | null> {
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true, title: true, currency: true } });
  if (!event) return null;

  const topups = await prisma.walletTransaction.findMany({
    where: topupWhere(eventId),
    select: { amountCents: true, mobileNetwork: true, airpayRef: true, createdAt: true, wallet: { select: { code: true } } },
  });
  const directSales = await prisma.directSaleTransaction.findMany({
    where: directSaleWhere(eventId),
    select: { amountCents: true, mobileNetwork: true, airpayRef: true, createdAt: true, customerPhone: true },
  });

  const records: TopupRecord[] = [
    ...topups.map((t): TopupRecord => ({
      walletCode: `•••${t.wallet.code.slice(-4)}`,
      amountCents: t.amountCents ?? 0,
      mobileNetwork: t.mobileNetwork,
      airpayRef: t.airpayRef,
      createdAt: t.createdAt,
      source: "TOPUP",
    })),
    ...directSales.map((t): TopupRecord => ({
      walletCode: maskPhone(t.customerPhone),
      amountCents: t.amountCents,
      mobileNetwork: t.mobileNetwork,
      airpayRef: t.airpayRef,
      createdAt: t.createdAt,
      source: "DIRECT_SALE",
    })),
  ];

  return {
    eventId: event.id,
    eventTitle: event.title,
    summary: summarizeAirpayReconciliation(event.currency, records),
  };
}

// Full, unmasked transaction list for CSV export (point 3) — this is what
// the organiser's accountant or AirPay support needs for dispute
// resolution, so unlike the on-page exception table it carries the real
// wallet code/phone number, not a masked one. Session 28 — unioned with
// Direct Sale rows the same way getAirpayReconciliationData is, sorted back
// together by time so the export reads as one chronological ledger.
export async function getAirpayExportData(eventId: string): Promise<{ eventTitle: string; currency: string; rows: ExportRow[] } | null> {
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { title: true, currency: true } });
  if (!event) return null;

  const topups = await prisma.walletTransaction.findMany({
    where: topupWhere(eventId),
    select: { createdAt: true, amountCents: true, mobileNetwork: true, airpayRef: true, wallet: { select: { code: true } } },
  });
  const directSales = await prisma.directSaleTransaction.findMany({
    where: directSaleWhere(eventId),
    select: { createdAt: true, amountCents: true, mobileNetwork: true, airpayRef: true, customerPhone: true },
  });

  const rows: ExportRow[] = [
    ...topups.map((t): ExportRow => ({
      createdAt: t.createdAt,
      amountCents: t.amountCents,
      mobileNetwork: t.mobileNetwork,
      airpayRef: t.airpayRef,
      identifier: t.wallet.code,
      source: "TOPUP",
    })),
    ...directSales.map((t): ExportRow => ({
      createdAt: t.createdAt,
      amountCents: t.amountCents,
      mobileNetwork: t.mobileNetwork,
      airpayRef: t.airpayRef,
      identifier: t.customerPhone,
      source: "DIRECT_SALE",
    })),
  ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  return { eventTitle: event.title, currency: event.currency, rows };
}

interface ExportRow {
  createdAt: Date;
  amountCents: number | null;
  mobileNetwork: string | null;
  airpayRef: string | null;
  identifier: string;
  source: "TOPUP" | "DIRECT_SALE";
}

export function buildAirpayReconciliationCsv(eventTitle: string, rows: ExportRow[]): string {
  const sections: CsvSection[] = [
    {
      title: `AirPay reconciliation — ${eventTitle}`,
      headers: ["Time", "Type", "Wallet Code / Phone", "Amount (Major Units)", "Payment Method", "AirPay Reference"],
      rows: rows.map((r) => [
        r.createdAt.toISOString(),
        r.source === "DIRECT_SALE" ? "Direct Sale" : "Top-up",
        r.identifier,
        centsToMajorUnits(r.amountCents ?? 0),
        labelForMethod(r.mobileNetwork),
        r.airpayRef ?? "",
      ]),
    },
  ];
  return buildCsvDocument(sections);
}
