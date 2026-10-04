"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import Spinner from "@/components/Spinner";

interface ResultRow {
  overallRank: number;
  categoryRank: number;
  athleteName: string;
  bib: string;
  ticketTypeName: string;
  gunTimeFormatted: string;
  chipTimeFormatted: string | null;
  pace: string;
  speed: string;
  medal: 1 | 2 | 3 | null;
}

interface DNFRow {
  athleteName: string;
  bib: string;
  ticketTypeName: string;
  reason?: string;
}

interface ResultsPayload {
  eventId: string;
  eventTitle: string;
  eventType: string;
  venue: string;
  city: string;
  startsAt: string;
  results: ResultRow[];
  dnfs: DNFRow[];
  counts: { totalStarters: number; totalFinishers: number; dnfCount: number };
}

const MEDAL = { 1: "🥇", 2: "🥈", 3: "🥉" } as const;

// Public, unauthenticated — a clean, printable version of the same finish
// data the live leaderboard shows, plus the DNF list. Not i18n'd (unlike
// the live leaderboard page) — this feature's spec never asked for a
// Swahili translation, so plain English keeps this in scope.
export default function PublicResultsPage() {
  const { slug } = useParams<{ slug: string }>();

  const [data, setData] = useState<ResultsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/events/${slug}/results`, { cache: "no-store" });
        const body = await res.json();
        if (cancelled) return;
        if (!body.ok) {
          setError("Results not found.");
          return;
        }
        setData(body);
      } catch {
        if (!cancelled) setError("Couldn't load results.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (!data && error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center">
        <p className="font-semibold">{error}</p>
        <Link href="/" className="btn-secondary mt-6 inline-flex">Back home</Link>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-3 px-4 py-16 text-center text-muted">
        <Spinner />
        <span>Loading…</span>
      </div>
    );
  }

  const isMountainBike = data.eventType === "MOUNTAIN_BIKE";
  const athleteLabel = isMountainBike ? "Rider" : "Athlete";
  const paceLabel = isMountainBike ? "Speed" : "Pace";

  return (
    <div className="mx-auto max-w-4xl px-4 pb-20 pt-8 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-muted">Official Results</p>
          <h1 className="text-2xl font-bold">{data.eventTitle}</h1>
          <p className="mt-1 text-sm text-muted">
            {new Date(data.startsAt).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
            {" · "}
            {data.venue}, {data.city}
          </p>
        </div>
        <div className="flex gap-2">
          <Link href={`/events/${slug}/leaderboard`} className="btn-secondary">Live leaderboard</Link>
          <a href={`/api/dashboard/events/${data.eventId}/results`} className="btn-primary">Download PDF</a>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-3 gap-4">
        <Stat label="Starters" value={data.counts.totalStarters} />
        <Stat label="Finishers" value={data.counts.totalFinishers} />
        <Stat label="DNF" value={data.counts.dnfCount} />
      </div>

      <h2 className="mb-3 mt-8 font-semibold">Finish results</h2>
      {data.results.length === 0 ? (
        <div className="card p-8 text-center text-muted">No finishers recorded yet.</div>
      ) : (
        <div className="card table-wrap overflow-x-auto p-0">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs font-medium uppercase tracking-wide text-muted">
                <th className="p-3">Rank</th>
                <th className="p-3">Cat.</th>
                <th className="p-3">{athleteLabel}</th>
                <th className="p-3">Category</th>
                <th className="p-3 text-right">Gun time</th>
                <th className="p-3 text-right">Chip time</th>
                <th className="p-3 text-right">{paceLabel}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.results.map((r) => (
                <tr key={`${r.overallRank}-${r.bib}`}>
                  <td className="p-3 font-bold tabular-nums">{r.overallRank}</td>
                  <td className="p-3 tabular-nums">{r.medal ? `${MEDAL[r.medal]} ${r.categoryRank}` : r.categoryRank}</td>
                  <td className="p-3 font-medium">{r.athleteName}</td>
                  <td className="p-3">{r.ticketTypeName}</td>
                  <td className="p-3 text-right font-mono">{r.gunTimeFormatted}</td>
                  <td className="p-3 text-right font-mono text-muted">{r.chipTimeFormatted ?? "—"}</td>
                  <td className="p-3 text-right">{isMountainBike ? r.speed : r.pace}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="mb-3 mt-8 font-semibold">Did Not Finish</h2>
      {data.dnfs.length === 0 ? (
        <div className="card p-6 text-center text-muted">No DNFs recorded.</div>
      ) : (
        <div className="card divide-y divide-border">
          {data.dnfs.map((d) => (
            <div key={d.bib} className="flex items-center justify-between p-3 text-sm">
              <span className="font-medium">{d.athleteName}</span>
              <span className="text-muted">{d.reason ? `${d.ticketTypeName} · ${d.reason}` : d.ticketTypeName}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card p-5 text-center">
      <p className="text-2xl font-bold tabular-nums">{value}</p>
      <p className="mt-1 text-xs uppercase tracking-wide text-muted">{label}</p>
    </div>
  );
}
