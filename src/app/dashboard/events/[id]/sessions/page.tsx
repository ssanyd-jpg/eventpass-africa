"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useAppSession } from "@/lib/use-app-session";
import { formatDateTime } from "@/lib/format";
import { SkeletonPage } from "@/components/Skeleton";

interface SessionRow {
  id: string;
  name: string;
  speaker: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  attendanceCount: number;
}

interface HourPoint {
  hour: string;
  count: number;
}

interface SessionHeatmapRow {
  sessionId: string;
  sessionName: string;
  hours: HourPoint[];
}

interface RankedEntry {
  label: string;
  value: number;
}

interface ConferenceAnalyticsPayload {
  eventId: string;
  eventTitle: string;
  sessions: SessionRow[];
  totalAttendance: number;
  totalLeads: number;
  heatmap: SessionHeatmapRow[];
  peakHour: { hour: string; count: number } | null;
  exhibitorLeadTotals: RankedEntry[];
}

const POLL_INTERVAL_MS = 30000;

// Highest count across the whole grid, for shading each cell relative to
// the busiest slot — same "relative intensity, not an absolute scale"
// approach a heat map needs to be readable at a glance.
function maxCount(rows: SessionHeatmapRow[]): number {
  let max = 0;
  for (const row of rows) for (const h of row.hours) if (h.count > max) max = h.count;
  return max;
}

function heatColor(count: number, max: number): string {
  if (count === 0 || max === 0) return "transparent";
  const intensity = 0.15 + 0.7 * (count / max);
  return `color-mix(in srgb, var(--accent) ${Math.round(intensity * 100)}%, transparent)`;
}

export default function ConferenceSessionsDashboardPage() {
  const { id: rawId } = useParams<{ id: string }>();
  const eventId = decodeURIComponent(rawId);
  const router = useRouter();
  const { user } = useAppSession();

  useEffect(() => {
    if (user?.organizationRole === "GATE_CREW") router.replace("/dashboard");
  }, [user, router]);

  const [data, setData] = useState<ConferenceAnalyticsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/dashboard/events/${eventId}/sessions`, { cache: "no-store" });
      const body = await res.json();
      if (!body.ok) {
        setError(body.reason === "NOT_FOUND" ? "Event not found." : "Couldn't load session data.");
        return;
      }
      setError(null);
      setData(body);
    } catch {
      setError((prev) => prev ?? "Couldn't load session data.");
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
    return <SkeletonPage maxWidth="max-w-4xl" />;
  }

  const max = maxCount(data.heatmap);

  return (
    <div className="mx-auto max-w-4xl px-4 pb-20 pt-8 sm:px-6">
      <Link href={`/dashboard/events/${eventId}`} className="text-sm text-muted hover:text-foreground">
        ← {data.eventTitle}
      </Link>
      <h1 className="mt-3 text-2xl font-bold">Sessions dashboard</h1>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Sessions" value={data.sessions.length} />
        <Stat label="Total attendance taps" value={data.totalAttendance} />
        <Stat label="Peak time" value={data.peakHour ? `${data.peakHour.hour} (${data.peakHour.count})` : "—"} />
        <Stat label="Exhibitor leads captured" value={data.totalLeads} />
      </div>

      <h2 className="mb-3 mt-8 font-semibold">Sessions</h2>
      {data.sessions.length === 0 ? (
        <div className="card p-6 text-center text-muted">No sessions set up yet.</div>
      ) : (
        <div className="card divide-y divide-border">
          {data.sessions.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
              <div>
                <p className="font-medium">{s.name}</p>
                <p className="text-xs text-muted">
                  {formatDateTime(s.startsAt)}
                  {s.location ? ` · ${s.location}` : ""}
                  {s.speaker ? ` · ${s.speaker}` : ""}
                </p>
              </div>
              <span className="pill">{s.attendanceCount} attended</span>
            </div>
          ))}
        </div>
      )}

      <h2 className="mb-3 mt-8 font-semibold">Attendance heat map — sessions by hour</h2>
      {data.heatmap.length === 0 || max === 0 ? (
        <div className="card p-6 text-center text-muted">No attendance recorded yet.</div>
      ) : (
        <div className="card table-wrap overflow-x-auto p-4">
          <table className="w-full border-separate text-left text-xs" style={{ borderSpacing: 2 }}>
            <thead>
              <tr>
                <th className="p-2 text-left font-medium text-muted">Session</th>
                {data.heatmap[0].hours.map((h) => (
                  <th key={h.hour} className="p-2 text-center font-medium text-muted">{h.hour}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.heatmap.map((row) => (
                <tr key={row.sessionId}>
                  <td className="whitespace-nowrap p-2 font-medium">{row.sessionName}</td>
                  {row.hours.map((h) => (
                    <td
                      key={h.hour}
                      title={`${row.sessionName} · ${h.hour} · ${h.count}`}
                      className="p-2 text-center tabular-nums"
                      style={{ background: heatColor(h.count, max) }}
                    >
                      {h.count > 0 ? h.count : ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="mb-3 mt-8 font-semibold">Exhibitor leads by vendor</h2>
      {data.exhibitorLeadTotals.length === 0 ? (
        <div className="card p-6 text-center text-muted">No exhibitor leads captured yet.</div>
      ) : (
        <div className="card divide-y divide-border">
          {data.exhibitorLeadTotals.map((entry) => (
            <div key={entry.label} className="flex items-center justify-between p-3 text-sm">
              <span>{entry.label}</span>
              <span className="tabular-nums font-semibold">{entry.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card p-5">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}
