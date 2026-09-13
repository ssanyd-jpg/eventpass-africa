"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useAppSession } from "@/lib/use-app-session";
import { formatCents, formatDateTime } from "@/lib/format";

interface MethodRow {
  method: string;
  label: string;
  count: number;
  amountCents: number;
  percentOfVolume: number;
}

interface ExceptionRow {
  walletCode: string;
  amountCents: number;
  method: string;
  label: string;
  createdAt: string;
}

interface AirpayReconciliationPayload {
  eventId: string;
  eventTitle: string;
  summary: {
    currency: string;
    totalCount: number;
    totalAmountCents: number;
    matchedCount: number;
    matchedAmountCents: number;
    exceptionCount: number;
    exceptionAmountCents: number;
    expectedSettlementCents: number;
    varianceCents: number;
    methodBreakdown: MethodRow[];
    exceptions: ExceptionRow[];
  };
}

export default function AirpayReconciliationPage() {
  const { id: rawId } = useParams<{ id: string }>();
  const eventId = decodeURIComponent(rawId);
  const router = useRouter();
  const { user } = useAppSession();

  // This is financial data — OWNER only, stricter than every sibling
  // report page (forecast/reconciliation), which only block GATE_CREW.
  // Client-side redirect is UI-hiding only; canAccessAirpayReconciliation
  // in the API route is the real enforcement (see airpay-reconciliation-
  // data.ts).
  useEffect(() => {
    if (user && user.organizationRole !== "OWNER") router.replace("/dashboard");
  }, [user, router]);

  const [data, setData] = useState<AirpayReconciliationPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/dashboard/events/${eventId}/airpay-reconciliation`, { cache: "no-store" });
      const body = await res.json();
      if (!body.ok) {
        setError(
          body.reason === "FORBIDDEN"
            ? "Only the organization owner can view AirPay reconciliation."
            : body.reason === "NOT_FOUND"
              ? "Event not found."
              : "Couldn't load the AirPay reconciliation report."
        );
        return;
      }
      setError(null);
      setData(body);
    } catch {
      setError((prev) => prev ?? "Couldn't load the AirPay reconciliation report.");
    }
  }, [eventId]);

  useEffect(() => {
    load();
  }, [load]);

  if (user && user.organizationRole !== "OWNER") return null;

  if (!data && error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center">
        <p className="font-semibold">{error}</p>
        <Link href={`/dashboard/events/${eventId}`} className="btn-secondary mt-6 inline-flex">Back to event</Link>
      </div>
    );
  }
  if (!data) {
    return <div className="mx-auto max-w-3xl px-4 py-16 text-center text-muted">Loading…</div>;
  }

  const { summary } = data;
  const c = summary.currency;

  return (
    <div className="mx-auto max-w-5xl px-4 pb-20 pt-8 sm:px-6">
      <Link href={`/dashboard/events/${eventId}`} className="text-sm text-muted hover:text-foreground">
        ← {data.eventTitle}
      </Link>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">AirPay reconciliation</h1>
        <a href={`/api/dashboard/events/${eventId}/airpay-reconciliation/export`} className="btn-secondary">
          Export CSV
        </a>
      </div>
      <p className="mt-1 text-sm text-muted">
        Matches every confirmed Chaap top-up against AirPay&apos;s own reference number, for post-event financial verification.
      </p>

      <h2 className="mb-3 mt-8 font-semibold">Summary</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SummaryCard label="Confirmed top-ups" value={`${summary.totalCount} · ${formatCents(summary.totalAmountCents, c)}`} />
        <SummaryCard label="Matched (has AirPay ref)" value={`${summary.matchedCount} · ${formatCents(summary.matchedAmountCents, c)}`} />
        <SummaryCard
          label="Exceptions (missing ref)"
          value={`${summary.exceptionCount} · ${formatCents(summary.exceptionAmountCents, c)}`}
          flag={summary.exceptionCount > 0}
        />
        <SummaryCard label="Expected AirPay settlement" value={formatCents(summary.expectedSettlementCents, c)} />
        <SummaryCard
          label="Variance vs. matched volume"
          value={formatCents(summary.varianceCents, c)}
          flag={summary.varianceCents !== 0}
        />
      </div>

      <h2 className="mb-3 mt-10 font-semibold">Payment method breakdown</h2>
      {summary.methodBreakdown.length === 0 ? (
        <div className="card p-8 text-center text-muted">No confirmed top-ups recorded for this event.</div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs font-medium uppercase tracking-wide text-muted">
                <th className="p-3">Method</th>
                <th className="p-3 text-right">Transactions</th>
                <th className="p-3 text-right">Total ({c})</th>
                <th className="p-3 text-right">% of volume</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {summary.methodBreakdown.map((row) => (
                <tr key={row.method}>
                  <td className="p-3 font-medium">{row.label}</td>
                  <td className="p-3 text-right tabular-nums">{row.count}</td>
                  <td className="p-3 text-right tabular-nums">{formatCents(row.amountCents, c)}</td>
                  <td className="p-3 text-right tabular-nums">{row.percentOfVolume.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="mb-3 mt-10 font-semibold">Exceptions — missing AirPay reference</h2>
      {summary.exceptions.length === 0 ? (
        <div className="card p-8 text-center text-muted">Every confirmed top-up has a matching AirPay reference.</div>
      ) : (
        <>
          <div className="card overflow-x-auto p-0">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs font-medium uppercase tracking-wide text-muted">
                  <th className="p-3">Time</th>
                  <th className="p-3">Wallet</th>
                  <th className="p-3 text-right">Amount</th>
                  <th className="p-3">Method</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {summary.exceptions.map((ex, i) => (
                  <tr key={i}>
                    <td className="p-3">{formatDateTime(ex.createdAt)}</td>
                    <td className="p-3 font-mono">{ex.walletCode}</td>
                    <td className="p-3 text-right tabular-nums">{formatCents(ex.amountCents, c)}</td>
                    <td className="p-3">{ex.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted">
            These need manual cross-reference with the AirPay merchant dashboard.
          </p>
        </>
      )}
    </div>
  );
}

function SummaryCard({ label, value, flag }: { label: string; value: string; flag?: boolean }) {
  return (
    <div className={`card p-5 ${flag ? "border-danger/40 bg-danger/5" : ""}`}>
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 text-xl font-bold tabular-nums ${flag ? "text-danger" : ""}`}>{value}</p>
    </div>
  );
}
