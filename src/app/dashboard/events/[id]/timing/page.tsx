"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useAppSession } from "@/lib/use-app-session";
import { formatElapsed } from "@/lib/timing";

interface LeaderRow {
  rank: number;
  athleteName: string;
  bib: string;
  ticketTypeName: string;
  gunTimeFormatted: string;
  pace: string;
  lastPointName?: string;
}

interface TimingPayload {
  eventId: string;
  eventTitle: string;
  gunStartAt: string | null;
  timingPoints: { id: string; name: string; sequenceOrder: number; isStart: boolean; isFinish: boolean }[];
  totalStarters: number;
  totalFinishers: number;
  dnfCount: number;
  raceEnded: boolean;
  perPointCounts: { timingPointId: string; name: string; count: number }[];
  leaders: { finishers: LeaderRow[]; inProgress: LeaderRow[] };
}

const POLL_INTERVAL_MS = 30000;

export default function TimingDashboardPage() {
  const { id: rawId } = useParams<{ id: string }>();
  const eventId = decodeURIComponent(rawId);
  const router = useRouter();
  const { user } = useAppSession();

  useEffect(() => {
    if (user?.organizationRole === "GATE_CREW") router.replace("/dashboard");
  }, [user, router]);

  const [data, setData] = useState<TimingPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/dashboard/events/${eventId}/timing`, { cache: "no-store" });
      const body = await res.json();
      if (!body.ok) {
        setError(body.reason === "NOT_FOUND" ? "Event not found." : "Couldn't load timing data.");
        return;
      }
      setError(null);
      setData(body);
    } catch {
      setError((prev) => prev ?? "Couldn't load timing data.");
    }
  }, [eventId]);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  if (user?.organizationRole === "GATE_CREW") return null;

  if (!data && error) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-16 text-center">
        <p className="font-semibold">{error}</p>
        <Link href={`/dashboard/events/${eventId}`} className="btn-secondary mt-6 inline-flex">Back to event</Link>
      </div>
    );
  }
  if (!data) {
    return <div className="mx-auto max-w-4xl px-4 py-16 text-center text-muted">Loading…</div>;
  }

  return (
    <div className="mx-auto max-w-4xl px-4 pb-20 pt-8 sm:px-6">
      <Link href={`/dashboard/events/${eventId}`} className="text-sm text-muted hover:text-foreground">
        ← {data.eventTitle}
      </Link>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Timing dashboard</h1>
        <a href={`/api/dashboard/events/${eventId}/timing/export`} className="btn-secondary">Export CSV</a>
      </div>

      {data.gunStartAt && (
        <p className="mt-2 text-sm text-muted">
          Gun time: <span className="font-mono">{formatElapsed((Date.now() - new Date(data.gunStartAt).getTime()) / 1000)}</span>
        </p>
      )}

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total starters" value={data.totalStarters} />
        <Stat label="Total finishers" value={data.totalFinishers} />
        <Stat label="DNF" value={data.raceEnded ? data.dnfCount : "—"} flag={data.raceEnded && data.dnfCount > 0} />
        <Stat label="Timing points" value={data.timingPoints.length} />
      </div>

      <h2 className="mb-3 mt-8 font-semibold">Per-timing-point counts</h2>
      <div className="card divide-y divide-border">
        {data.perPointCounts.map((p) => (
          <div key={p.timingPointId} className="flex items-center justify-between p-3 text-sm">
            <span>{p.name}</span>
            <span className="tabular-nums font-semibold">{p.count}</span>
          </div>
        ))}
      </div>

      <h2 className="mb-3 mt-8 font-semibold">Current leaders (on course)</h2>
      {data.leaders.inProgress.length === 0 ? (
        <div className="card p-6 text-center text-muted">No one on course yet.</div>
      ) : (
        <LeaderTable rows={data.leaders.inProgress.slice(0, 10)} />
      )}

      <h2 className="mb-3 mt-8 font-semibold">Finishers</h2>
      {data.leaders.finishers.length === 0 ? (
        <div className="card p-6 text-center text-muted">No finishers recorded yet.</div>
      ) : (
        <LeaderTable rows={data.leaders.finishers} />
      )}
    </div>
  );
}

function Stat({ label, value, flag }: { label: string; value: string | number; flag?: boolean }) {
  return (
    <div className={`card p-5 ${flag ? "border-warn/40 bg-warn/5" : ""}`}>
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

function LeaderTable({ rows }: { rows: LeaderRow[] }) {
  return (
    <div className="card overflow-x-auto p-0">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs font-medium uppercase tracking-wide text-muted">
            <th className="p-3">Rank</th>
            <th className="p-3">Athlete</th>
            <th className="p-3">Bib</th>
            <th className="p-3">Ticket type</th>
            <th className="p-3 text-right">Gun time</th>
            <th className="p-3 text-right">Pace</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={`${r.rank}-${r.bib}`}>
              <td className="p-3 tabular-nums">{r.rank}</td>
              <td className="p-3 font-medium">{r.athleteName}</td>
              <td className="p-3 font-mono">{r.bib}</td>
              <td className="p-3">{r.ticketTypeName}</td>
              <td className="p-3 text-right font-mono">{r.gunTimeFormatted}</td>
              <td className="p-3 text-right">{r.pace}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
