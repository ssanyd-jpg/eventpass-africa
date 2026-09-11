"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

interface LeaderRow {
  rank: number;
  athleteName: string;
  bib: string;
  ticketTypeName: string;
  gunTimeFormatted: string;
  pace: string;
}

interface LeaderboardPayload {
  eventTitle: string;
  ticketTypes: { id: string; name: string }[];
  finishers: LeaderRow[];
  inProgress: LeaderRow[];
  lastUpdated: string;
}

const POLL_INTERVAL_MS = 30000;

// Public, unauthenticated — anyone with the link sees this, no sign-in.
// Polls the leaderboard API route directly (never Dexie — this page isn't
// part of the offline-first buyer/organiser app at all, it's a plain
// race-day results board someone might open on a phone with no account).
export default function PublicLeaderboardPage() {
  const { slug } = useParams<{ slug: string }>();

  const [data, setData] = useState<LeaderboardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ticketTypeId, setTicketTypeId] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const url = `/api/events/${slug}/leaderboard${ticketTypeId ? `?ticketTypeId=${ticketTypeId}` : ""}`;
      const res = await fetch(url, { cache: "no-store" });
      const body = await res.json();
      if (!body.ok) {
        setError("Leaderboard not found.");
        return;
      }
      setError(null);
      setData(body);
    } catch {
      setError((prev) => prev ?? "Couldn't load the leaderboard.");
    }
  }, [slug, ticketTypeId]);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  async function share() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API unavailable — nothing sensible to fall back to here
    }
  }

  if (!data && error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center">
        <p className="font-semibold">{error}</p>
        <Link href="/" className="btn-secondary mt-6 inline-flex">Back home</Link>
      </div>
    );
  }
  if (!data) {
    return <div className="mx-auto max-w-3xl px-4 py-16 text-center text-muted">Loading…</div>;
  }

  return (
    <div className="mx-auto max-w-3xl px-4 pb-20 pt-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-muted">Live leaderboard</p>
          <h1 className="text-2xl font-bold">{data.eventTitle}</h1>
        </div>
        <button className="btn-secondary" onClick={share}>{copied ? "Link copied!" : "Share"}</button>
      </div>

      {data.ticketTypes.length > 1 && (
        <div className="mt-4">
          <label className="label" htmlFor="ticketType">Race</label>
          <select
            id="ticketType"
            className="input"
            value={ticketTypeId}
            onChange={(e) => setTicketTypeId(e.target.value)}
          >
            <option value="">All races</option>
            {data.ticketTypes.map((tt) => (
              <option key={tt.id} value={tt.id}>{tt.name}</option>
            ))}
          </select>
        </div>
      )}

      <p className="mt-3 text-xs text-muted">Updates every 30 seconds · last updated {new Date(data.lastUpdated).toLocaleTimeString()}</p>

      {data.inProgress.length > 0 && (
        <>
          <h2 className="mb-3 mt-6 font-semibold">On course</h2>
          <LeaderTable rows={data.inProgress} />
        </>
      )}

      <h2 className="mb-3 mt-6 font-semibold">Finishers</h2>
      {data.finishers.length === 0 ? (
        <div className="card p-8 text-center text-muted">No finishers yet.</div>
      ) : (
        <LeaderTable rows={data.finishers} />
      )}
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
            <th className="p-3 text-right">Gun time</th>
            <th className="p-3 text-right">Pace</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={`${r.rank}-${r.bib}`}>
              <td className="p-3 font-bold tabular-nums">{r.rank}</td>
              <td className="p-3 font-medium">{r.athleteName}</td>
              <td className="p-3 font-mono">{r.bib}</td>
              <td className="p-3 text-right font-mono">{r.gunTimeFormatted}</td>
              <td className="p-3 text-right">{r.pace}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
