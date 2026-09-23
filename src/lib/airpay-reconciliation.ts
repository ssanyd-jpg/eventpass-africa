// Session 18 — AirPay payment reconciliation analytics. Pure functions,
// DB-free, taking pre-fetched data as input — follows the pattern of
// src/lib/revenue-forecast.ts / src/lib/sponsor-campaign-analytics.ts.
//
// The payment-method set here is the real one this codebase supports for
// wallet top-ups: TOPUP_WALLET's payload only ever carries
// MPESA | TIGO | AIRTEL | HALOTEL (see the zod schema in sync-handlers.ts).
// There is no Visa/Mastercard/Cash/T-Pesa/EzyPesa concept for wallet
// top-ups in this app — top-ups are always digital, buyer-initiated mobile
// money charges, never a card or in-person cash flow — so the breakdown
// below only ever produces rows for these four networks plus "Unknown"
// (a null/unrecognized network, e.g. any row created before mobileNetwork
// started being persisted).

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  MPESA: "M-Pesa",
  TIGO: "Tigo Pesa",
  AIRTEL: "Airtel Money",
  HALOTEL: "HaloPesa",
};
export const UNKNOWN_METHOD_LABEL = "Unknown";

export function labelForMethod(mobileNetwork: string | null): string {
  return (mobileNetwork && PAYMENT_METHOD_LABELS[mobileNetwork]) || UNKNOWN_METHOD_LABEL;
}

export interface TopupRecord {
  // Already masked/unmasked as the caller wants it displayed — this
  // function only ever passes it through, matching the masking-at-the-
  // data-layer convention of sponsor-dashboard-data.ts's maskedCode. For a
  // DIRECT_SALE row (see `source` below) this holds the masked customer
  // phone number instead of a wallet code — there is no wallet.
  walletCode: string;
  amountCents: number;
  mobileNetwork: string | null;
  airpayRef: string | null;
  createdAt: Date;
  // Session 28 — which AirPay-confirmed money flow this row came from.
  // Optional and defaults to "TOPUP" when absent so every pre-existing
  // caller (and every existing test's TopupRecord literal) keeps working
  // unchanged — Direct Sale is unioned into the SAME report, not a
  // parallel one, since both are AirPay-confirmed revenue reconciled the
  // same way (matched-by-airpayRef vs. exception).
  source?: "TOPUP" | "DIRECT_SALE";
}

export interface PaymentMethodBreakdownRow {
  method: string; // "MPESA" | "TIGO" | "AIRTEL" | "HALOTEL" | "UNKNOWN"
  label: string;
  count: number;
  amountCents: number;
  percentOfVolume: number; // 0-100
}

export interface ExceptionRow {
  walletCode: string;
  amountCents: number;
  method: string;
  label: string;
  createdAt: string;
  source: "TOPUP" | "DIRECT_SALE";
}

export interface AirpayReconciliationSummary {
  currency: string;
  totalCount: number;
  totalAmountCents: number;
  matchedCount: number;
  matchedAmountCents: number;
  exceptionCount: number;
  exceptionAmountCents: number;
  // "Total AirPay settlement expected" — every confirmed top-up is money
  // AirPay should eventually settle, whether or not it carries a reference
  // yet. Equal to totalAmountCents by construction (see the module note on
  // varianceCents below).
  expectedSettlementCents: number;
  // expectedSettlementCents - matchedAmountCents. In THIS app's data, that
  // makes it always >= 0 (matched is always a subset of the confirmed
  // total) — it is exactly the exception volume, restated as a variance so
  // the summary card can flag it in red the same way the Session 9
  // cash-float variance does. computeSettlementVariance itself is a plain,
  // general subtraction the tests exercise with synthetic zero/positive/
  // negative inputs, same convention as reconciliation.ts's computeVariance.
  varianceCents: number;
  methodBreakdown: PaymentMethodBreakdownRow[];
  exceptions: ExceptionRow[];
}

export function computeSettlementVariance(expectedCents: number, matchedCents: number): number {
  return expectedCents - matchedCents;
}

export function summarizeAirpayReconciliation(currency: string, topups: TopupRecord[]): AirpayReconciliationSummary {
  const totalCount = topups.length;
  const totalAmountCents = topups.reduce((sum, t) => sum + t.amountCents, 0);

  const matched = topups.filter((t) => !!t.airpayRef);
  const exceptions = topups.filter((t) => !t.airpayRef);
  const matchedAmountCents = matched.reduce((sum, t) => sum + t.amountCents, 0);
  const exceptionAmountCents = exceptions.reduce((sum, t) => sum + t.amountCents, 0);

  const expectedSettlementCents = totalAmountCents;
  const varianceCents = computeSettlementVariance(expectedSettlementCents, matchedAmountCents);

  const byMethod = new Map<string, { count: number; amountCents: number }>();
  for (const t of topups) {
    const key = t.mobileNetwork && PAYMENT_METHOD_LABELS[t.mobileNetwork] ? t.mobileNetwork : "UNKNOWN";
    const entry = byMethod.get(key) ?? { count: 0, amountCents: 0 };
    entry.count += 1;
    entry.amountCents += t.amountCents;
    byMethod.set(key, entry);
  }
  const methodBreakdown: PaymentMethodBreakdownRow[] = Array.from(byMethod.entries())
    .map(([method, v]) => ({
      method,
      label: method === "UNKNOWN" ? UNKNOWN_METHOD_LABEL : PAYMENT_METHOD_LABELS[method],
      count: v.count,
      amountCents: v.amountCents,
      percentOfVolume: totalAmountCents > 0 ? (v.amountCents / totalAmountCents) * 100 : 0,
    }))
    .sort((a, b) => b.amountCents - a.amountCents);

  return {
    currency,
    totalCount,
    totalAmountCents,
    matchedCount: matched.length,
    matchedAmountCents,
    exceptionCount: exceptions.length,
    exceptionAmountCents,
    expectedSettlementCents,
    varianceCents,
    methodBreakdown,
    exceptions: exceptions
      .map((t) => ({
        walletCode: t.walletCode,
        amountCents: t.amountCents,
        method: t.mobileNetwork ?? "UNKNOWN",
        label: labelForMethod(t.mobileNetwork),
        createdAt: t.createdAt.toISOString(),
        source: t.source ?? "TOPUP",
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  };
}
