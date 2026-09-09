"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { signOut } from "next-auth/react";
import { formatCents } from "@/lib/format";
import LineSeries from "@/components/charts/LineSeries";

// 60s, not the 30s the organiser live-monitoring page uses — see point 3 of
// the Session 8 spec: vendors don't need second-by-second granularity, and
// the wider interval halves the DB load this one extra polling surface adds.
const POLL_INTERVAL_MS = 60000;
const CLOCK_TICK_MS = 15000; // just for refreshing the "Xm ago" text between polls

const SETTLEMENT_LABEL: Record<string, string> = { PENDING: "Pending", PROCESSING: "Processing", SETTLED: "Settled" };

interface DashboardData {
  vendorName: string;
  eventTitle: string;
  currency: string;
  lastUpdated: string;
  stats: { todaysSalesTotalCents: number; transactionCount: number; averageTransactionCents: number };
  salesByHour: { hour: string; count: number; amountCents: number }[];
  topItems: { item: string; amountCents: number }[];
  settlement: { status: string; amountCents: number; processedAt: string | null };
  transactions: { id: string; createdAt: string; item: string | null; amountCents: number | null; status: string; walletCodeLast4: string }[];
}

function timeAgo(date: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - date.getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 min ago";
  return `${minutes} min ago`;
}

export default function VendorDashboardPage() {
  const { vendorId } = useParams<{ vendorId: string }>();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/vendor/${vendorId}/dashboard`, { cache: "no-store" });
      const body = await res.json();
      if (!body.ok) {
        setError((prev) => prev ?? "Couldn't load your dashboard.");
        return;
      }
      setError(null);
      setData(body);
    } catch {
      // A dropped connection never wipes the last known-good numbers — same
      // "stale data with a timestamp beats a blank screen" discipline the
      // organiser live-monitoring page uses.
    }
  }, [vendorId]);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    const clock = setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => clearInterval(clock);
  }, []);

  if (!data && error) {
    return (
      <div className="flex min-h-[80vh] flex-col items-center justify-center gap-4 px-5 text-center">
        <p className="text-xl font-semibold">{error}</p>
        <button onClick={() => signOut({ callbackUrl: "/vendor/login" })} className="btn-secondary !h-12 !text-base">
          Sign out
        </button>
      </div>
    );
  }

  if (!data) {
    return <div className="flex min-h-[80vh] items-center justify-center text-lg text-muted">Loading…</div>;
  }

  const { stats, settlement, currency } = data;
  const lastUpdatedAt = new Date(data.lastUpdated);

  return (
    <div className="mx-auto max-w-lg px-4 pb-16 pt-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted">{data.eventTitle}</p>
          <h1 className="text-2xl font-bold leading-tight">{data.vendorName}</h1>
        </div>
        <button onClick={() => signOut({ callbackUrl: "/vendor/login" })} className="text-sm font-medium text-muted underline">
          Sign out
        </button>
      </div>

      <p className={`mt-2 text-sm ${error ? "text-warn" : "text-muted"}`}>
        {error ? "Connection issue — " : ""}Last updated {timeAgo(lastUpdatedAt, now)}
      </p>

      {/* Today's headline number gets the most visual weight — a vendor
          glancing at their phone between customers needs this in under a
          second, in bright outdoor light. */}
      <div className="card mt-4 p-6 text-center">
        <p className="text-sm font-medium uppercase tracking-wide text-muted">Today&rsquo;s sales</p>
        <p className="mt-1 text-5xl font-extrabold tabular-nums">{formatCents(stats.todaysSalesTotalCents, currency)}</p>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <div className="card p-4 text-center">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Transactions</p>
          <p className="mt-1 text-3xl font-bold tabular-nums">{stats.transactionCount}</p>
        </div>
        <div className="card p-4 text-center">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Avg. sale</p>
          <p className="mt-1 text-3xl font-bold tabular-nums">{formatCents(stats.averageTransactionCents, currency)}</p>
        </div>
      </div>

      <h2 className="mb-3 mt-6 text-lg font-bold">Sales by hour</h2>
      <div className="card p-5">
        <LineSeries data={data.salesByHour.map((h) => ({ label: h.hour, value: Math.round(h.amountCents / 100) }))} />
      </div>

      <h2 className="mb-3 mt-6 text-lg font-bold">Top sellers today</h2>
      {data.topItems.length === 0 ? (
        <div className="card p-6 text-center text-base text-muted">No sales yet today.</div>
      ) : (
        <div className="card divide-y divide-border">
          {data.topItems.map((row) => (
            <div key={row.item} className="flex items-center justify-between p-4 text-base">
              <span className="font-medium">{row.item}</span>
              <span className="tabular-nums">{formatCents(row.amountCents, currency)}</span>
            </div>
          ))}
        </div>
      )}

      <h2 className="mb-3 mt-6 text-lg font-bold">Settlement</h2>
      <div className="card flex items-center justify-between p-5">
        <div>
          <p
            className={`text-lg font-bold ${
              settlement.status === "SETTLED" ? "text-ok" : settlement.status === "PROCESSING" ? "text-warn" : "text-muted"
            }`}
          >
            {SETTLEMENT_LABEL[settlement.status] ?? settlement.status}
          </p>
          {settlement.status !== "SETTLED" && <p className="text-sm text-muted">Owed so far, this event</p>}
        </div>
        <p className="text-2xl font-bold tabular-nums">{formatCents(settlement.amountCents, currency)}</p>
      </div>

      <h2 className="mb-3 mt-6 text-lg font-bold">Today&rsquo;s transactions</h2>
      {data.transactions.length === 0 ? (
        <div className="card p-6 text-center text-base text-muted">Nothing recorded yet today.</div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-left text-base">
            <thead>
              <tr className="border-b border-border text-xs font-medium uppercase tracking-wide text-muted">
                <th className="p-3">Time</th>
                <th className="p-3">Item</th>
                <th className="p-3 text-right">Amount</th>
                <th className="p-3 text-right">Wallet</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.transactions.map((tx) => (
                <tr key={tx.id} className={tx.status !== "COMPLETED" ? "opacity-50" : ""}>
                  <td className="whitespace-nowrap p-3 tabular-nums">
                    {new Date(tx.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </td>
                  <td className="p-3">{tx.item ?? "—"}</td>
                  <td className="p-3 text-right tabular-nums">
                    {tx.amountCents != null ? formatCents(tx.amountCents, currency) : "—"}
                    {tx.status !== "COMPLETED" && <span className="ml-1 text-xs text-danger">declined</span>}
                  </td>
                  <td className="p-3 text-right font-mono text-sm text-muted">•••{tx.walletCodeLast4}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
