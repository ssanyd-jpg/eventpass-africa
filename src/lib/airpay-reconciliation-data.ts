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

export async function getAirpayReconciliationData(eventId: string): Promise<AirpayReconciliationPageData | null> {
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true, title: true, currency: true } });
  if (!event) return null;

  const topups = await prisma.walletTransaction.findMany({
    where: topupWhere(eventId),
    select: { amountCents: true, mobileNetwork: true, airpayRef: true, createdAt: true, wallet: { select: { code: true } } },
  });

  const records: TopupRecord[] = topups.map((t) => ({
    walletCode: `•••${t.wallet.code.slice(-4)}`,
    amountCents: t.amountCents ?? 0,
    mobileNetwork: t.mobileNetwork,
    airpayRef: t.airpayRef,
    createdAt: t.createdAt,
  }));

  return {
    eventId: event.id,
    eventTitle: event.title,
    summary: summarizeAirpayReconciliation(event.currency, records),
  };
}

// Full, unmasked transaction list for CSV export (point 3) — this is what
// the organiser's accountant or AirPay support needs for dispute
// resolution, so unlike the on-page exception table it carries the real
// wallet code, not a masked one.
export async function getAirpayExportData(eventId: string): Promise<{ eventTitle: string; currency: string; rows: ExportRow[] } | null> {
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { title: true, currency: true } });
  if (!event) return null;

  const rows = await prisma.walletTransaction.findMany({
    where: topupWhere(eventId),
    select: { createdAt: true, amountCents: true, mobileNetwork: true, airpayRef: true, wallet: { select: { code: true } } },
    orderBy: { createdAt: "asc" },
  });

  return { eventTitle: event.title, currency: event.currency, rows };
}

interface ExportRow {
  createdAt: Date;
  amountCents: number | null;
  mobileNetwork: string | null;
  airpayRef: string | null;
  wallet: { code: string };
}

export function buildAirpayReconciliationCsv(eventTitle: string, rows: ExportRow[]): string {
  const sections: CsvSection[] = [
    {
      title: `AirPay reconciliation — ${eventTitle}`,
      headers: ["Time", "Wallet Code", "Amount (Major Units)", "Payment Method", "AirPay Reference"],
      rows: rows.map((r) => [
        r.createdAt.toISOString(),
        r.wallet.code,
        centsToMajorUnits(r.amountCents ?? 0),
        labelForMethod(r.mobileNetwork),
        r.airpayRef ?? "",
      ]),
    },
  ];
  return buildCsvDocument(sections);
}
