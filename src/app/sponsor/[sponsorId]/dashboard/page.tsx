"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { signOut } from "next-auth/react";
import { formatCents } from "@/lib/format";
import LineSeries from "@/components/charts/LineSeries";

// 60s, matching the vendor dashboard's own cadence (see point 3 of the
// Session 16 spec) — a sponsor checking their phone from the activation
// booth doesn't need second-by-second granularity, and the wider interval
// halves the DB load this extra polling surface adds.
const POLL_INTERVAL_MS = 60000;
const CLOCK_TICK_MS = 15000; // just for refreshing the "Xm ago" text between polls

interface DashboardData {
  sponsorName: string;
  eventTitle: string;
  currency: string;
  lastUpdated: string;
  stats: {
    totalTapsToday: number;
    uniqueAttendeesToday: number;
    averageDwellMinutes: number | null;
    costPerVisitCents: number | null;
  };
  tapsByHour: { hour: string; count: number }[];
  campaignBreakdown: { id: string; name: string; redemptions: number }[];
  recentActivity: { id: string; createdAt: string; maskedCode: string }[];
}

function timeAgo(date: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - date.getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 min ago";
  return `${minutes} min ago`;
}

export default function SponsorDashboardPage() {
  const { sponsorId } = useParams<{ sponsorId: string }>();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/sponsor/${sponsorId}/dashboard`, { cache: "no-store" });
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
      // vendor dashboard uses.
    }
  }, [sponsorId]);

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
        <button onClick={() => signOut({ callbackUrl: "/sponsor/login" })} className="btn-secondary !h-12 !text-base">
          Sign out
        </button>
      </div>
    );
  }

  if (!data) {
    return <div className="flex min-h-[80vh] items-center justify-center text-lg text-muted">Loading…</div>;
  }

  const { stats, currency } = data;
  const lastUpdatedAt = new Date(data.lastUpdated);

  return (
    <div className="mx-auto max-w-lg px-4 pb-16 pt-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted">{data.eventTitle}</p>
          <h1 className="text-2xl font-bold leading-tight">{data.sponsorName}</h1>
        </div>
        <button onClick={() => signOut({ callbackUrl: "/sponsor/login" })} className="text-sm font-medium text-muted underline">
          Sign out
        </button>
      </div>

      <p className={`mt-2 text-sm ${error ? "text-warn" : "text-muted"}`}>
        {error ? "Connection issue — " : ""}Last updated {timeAgo(lastUpdatedAt, now)}
      </p>

      {/* Today's headline number gets the most visual weight — same
          in-bright-daylight, glance-in-under-a-second reasoning as the
          vendor dashboard's own "Today's sales" card. */}
      <div className="card mt-4 p-6 text-center">
        <p className="text-sm font-medium uppercase tracking-wide text-muted">Wristband taps today</p>
        <p className="mt-1 text-5xl font-extrabold tabular-nums">{stats.totalTapsToday}</p>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <div className="card p-4 text-center">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Unique attendees</p>
          <p className="mt-1 text-3xl font-bold tabular-nums">{stats.uniqueAttendeesToday}</p>
        </div>
        <div className="card p-4 text-center">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Avg. dwell time</p>
          <p className="mt-1 text-3xl font-bold tabular-nums">
            {stats.averageDwellMinutes != null ? `${stats.averageDwellMinutes}m` : "—"}
          </p>
        </div>
      </div>

      <h2 className="mb-3 mt-6 text-lg font-bold">Taps by hour</h2>
      <div className="card p-5">
        <LineSeries data={data.tapsByHour.map((h) => ({ label: h.hour, value: h.count }))} />
      </div>

      <h2 className="mb-3 mt-6 text-lg font-bold">Campaign redemptions</h2>
      {data.campaignBreakdown.length === 0 ? (
        <div className="card p-6 text-center text-base text-muted">No campaigns set up for this sponsor.</div>
      ) : (
        <div className="card divide-y divide-border">
          {data.campaignBreakdown.map((c) => (
            <div key={c.id} className="flex items-center justify-between p-4 text-base">
              <span className="font-medium">{c.name}</span>
              <span className="tabular-nums">{c.redemptions}</span>
            </div>
          ))}
        </div>
      )}

      <h2 className="mb-3 mt-6 text-lg font-bold">Cost per verified visit</h2>
      <div className="card flex items-center justify-between p-5">
        <p className="text-sm text-muted">Sponsorship fee ÷ unique attendees, all time</p>
        <p className="text-2xl font-bold tabular-nums">
          {stats.costPerVisitCents != null ? formatCents(stats.costPerVisitCents, currency) : "—"}
        </p>
      </div>

      <h2 className="mb-3 mt-6 text-lg font-bold">Live activity</h2>
      {data.recentActivity.length === 0 ? (
        <div className="card p-6 text-center text-base text-muted">No taps recorded yet today.</div>
      ) : (
        <div className="card divide-y divide-border">
          {data.recentActivity.map((row) => (
            <div key={row.id} className="flex items-center justify-between p-4 text-base">
              <span className="font-mono text-muted">{row.maskedCode}</span>
              <span className="tabular-nums text-sm text-muted">
                {new Date(row.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
