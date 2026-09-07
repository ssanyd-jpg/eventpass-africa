"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useAppSession } from "@/lib/use-app-session";
import { formatCents, formatDateTime } from "@/lib/format";
import LineSeries from "@/components/charts/LineSeries";
import type { HourPoint, VendorHourlyStats, LiveEventStats } from "@/lib/analytics";
import type { LiveActivityEntry } from "@/lib/live-activity";

const POLL_INTERVAL_MS = 30000;
const CLOCK_TICK_MS = 15000; // just for refreshing the "Xm ago" text between polls

const TYPE_LABEL: Record<LiveActivityEntry["type"], string> = {
  CHECK_IN: "Check-in",
  TOPUP: "Top-up",
  SALE: "Sale",
  SPONSOR_TAP: "Sponsor tap",
};
const TYPE_STYLE: Record<LiveActivityEntry["type"], string> = {
  CHECK_IN: "pill border-ok/40 bg-ok/10 text-ok",
  TOPUP: "pill border-accent/40 bg-accent/10 text-accent-hover",
  SALE: "pill",
  SPONSOR_TAP: "pill border-warn/40 bg-warn/10 text-warn",
};

interface LiveData {
  eventTitle: string;
  currency: string;
  stats: Omit<LiveEventStats, "lastUpdated"> & { lastUpdated: string };
  checkIns: HourPoint[];
  vendorHourly: VendorHourlyStats[];
  activity: (Omit<LiveActivityEntry, "at"> & { at: string })[];
}

export default function LiveEventPage() {
  const { id: rawId } = useParams<{ id: string }>();
  const id = decodeURIComponent(rawId);
  const router = useRouter();
  const { user } = useAppSession();

  // Same defense-in-depth as every other organizer-only page — middleware
  // already redirects GATE_CREW away from anything under /dashboard/events.
  useEffect(() => {
    if (user?.organizationRole === "GATE_CREW") router.replace("/dashboard");
  }, [user, router]);

  const [data, setData] = useState<LiveData | null>(null);
  const [initialError, setInitialError] = useState<string | null>(null);
  const [pollFailing, setPollFailing] = useState(false);
  const [now, setNow] = useState(() => new Date());

  // Consecutive-zero-check-in tracking for the gate-issue banner — this is
  // poll-to-poll history, so it has to live across renders, not be derived
  // from a single response.
  const consecutiveZeroRef = useRef(0);
  const [gateAlert, setGateAlert] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/dashboard/events/${id}/live`, { cache: "no-store" });
      const body = await res.json();
      if (!body.ok) {
        // A real, structural failure (not found / forbidden) — nothing
        // sensible to show yet if this is the very first load.
        setInitialError((prev) => prev ?? (body.reason === "NOT_FOUND" ? "Event not found." : "Couldn't load live stats."));
        setPollFailing(true);
        return;
      }
      setPollFailing(false);
      setInitialError(null);
      setData(body);

      if (body.stats.totalCheckedIn > 0) {
        consecutiveZeroRef.current = body.stats.checkInsLast30Min === 0 ? consecutiveZeroRef.current + 1 : 0;
      } else {
        consecutiveZeroRef.current = 0;
      }
      setGateAlert(consecutiveZeroRef.current >= 2);
    } catch {
      // Network hiccup — never wipe the last known-good data, just flag it.
      setPollFailing(true);
    }
  }, [id]);

  // Poll rather than a one-shot load — the whole point of this view is
  // watching numbers change during the event, not a static snapshot like
  // the 30-day analytics dashboard. Stale data with a timestamp beats a
  // blank screen: a failed poll never clears `data`, only flags `pollFailing`.
  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  // Ticks independently of the poll so "Last updated 2m ago" keeps counting
  // up between successful polls, not just jumping every 30s.
  useEffect(() => {
    const clock = setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => clearInterval(clock);
  }, []);

  if (user?.organizationRole === "GATE_CREW") return null;

  if (!data && !initialError) {
    return <div className="mx-auto max-w-5xl px-4 py-16 text-center text-muted">Loading…</div>;
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-16 text-center">
        <p className="font-semibold">{initialError}</p>
        <Link href={`/dashboard/events/${id}`} className="btn-secondary mt-6 inline-flex">Back to event</Link>
      </div>
    );
  }

  const { stats, checkIns, vendorHourly, currency, activity } = data;
  const maxCellCount = Math.max(1, ...vendorHourly.flatMap((v) => v.hours.map((h) => h.count)));
  const checkInPct = stats.capacityTotal > 0 ? Math.round((stats.totalCheckedIn / stats.capacityTotal) * 100) : 0;

  const lastUpdatedAt = new Date(stats.lastUpdated);
  const staleSeconds = Math.max(0, Math.round((now.getTime() - lastUpdatedAt.getTime()) / 1000));
  const staleMinutes = Math.floor(staleSeconds / 60);
  const isStale = pollFailing || staleSeconds > POLL_INTERVAL_MS / 1000 + 15;
  const lastUpdatedLabel = staleMinutes < 1 ? "just now" : `${staleMinutes} min ago`;

  // Approximated from the same hour-bucketed grid the heat map already
  // renders, rather than a separate precise-timestamp query: a vendor whose
  // last non-zero hour is at least 2 columns behind the current (rightmost)
  // column has gone at least one full hour quiet, which is what the 60+ min
  // threshold is really asking for.
  const columnCount = vendorHourly[0]?.hours.length ?? 0;
  const quietVendors = vendorHourly
    .map((v) => ({
      vendorName: v.vendorName,
      lastActiveIndex: v.hours.reduce((last, h, i) => (h.count > 0 ? i : last), -1),
    }))
    .filter((v) => v.lastActiveIndex >= 0 && columnCount - 1 - v.lastActiveIndex >= 2)
    .map((v) => v.vendorName);

  return (
    <div className="mx-auto max-w-5xl px-4 pb-20 pt-8 sm:px-6">
      <Link href={`/dashboard/events/${id}`} className="text-sm text-muted hover:text-foreground">← {data.eventTitle}</Link>

      <div className="mb-6 mt-3 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="mb-1 flex items-center gap-2 text-2xl font-bold">
            Live
            <span className="pill border-ok/40 bg-ok/10 text-ok">● updating</span>
          </h1>
          <p
            className={`pill gap-2 text-xs ${isStale ? "border-warn/40 bg-warn/10 text-warn" : "border-ok/40 bg-ok/10 text-ok"}`}
            title={formatDateTime(lastUpdatedAt)}
          >
            <span className={`h-2 w-2 rounded-full ${isStale ? "bg-warn" : "bg-ok"}`} />
            Last updated {lastUpdatedLabel}
            {pollFailing && " — reconnecting…"}
          </p>
        </div>
      </div>

      {gateAlert && (
        <div className="mb-3 rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          <strong>Possible gate issue</strong> — no check-ins in the last 30 minutes across two consecutive checks.
        </div>
      )}
      {quietVendors.length > 0 && (
        <div className="mb-3 rounded-lg border border-warn/40 bg-warn/10 p-4 text-sm text-warn">
          <strong>Vendor gone quiet</strong> — {quietVendors.join(", ")} {quietVendors.length === 1 ? "hasn't" : "haven't"} sold anything in over an hour.
        </div>
      )}
      {checkInPct >= 100 && (
        <div className="mb-3 rounded-lg border border-warn/40 bg-warn/10 p-4 text-sm text-warn">
          <strong>At capacity</strong> — {stats.totalCheckedIn} checked in against {stats.capacityTotal} total.
        </div>
      )}
      {checkInPct >= 80 && checkInPct < 100 && (
        <div className="mb-3 rounded-lg border border-accent/40 bg-accent/10 p-4 text-sm text-accent-hover">
          Attendance has passed 80% of capacity ({checkInPct}%).
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div className="card p-5">
          <p className="text-xs uppercase tracking-wide text-muted">Checked in</p>
          <p className="mt-1 text-2xl font-bold">{stats.totalCheckedIn} / {stats.capacityTotal}</p>
          <p className="mt-1 text-xs text-muted">{checkInPct}% of capacity</p>
        </div>
        <div className="card p-5">
          <p className="text-xs uppercase tracking-wide text-muted">Arriving now</p>
          <p className="mt-1 text-2xl font-bold">{stats.checkInsLast30Min}</p>
          <p className="mt-1 text-xs text-muted">check-ins, last 30 min</p>
        </div>
        <div className="card p-5">
          <p className="text-xs uppercase tracking-wide text-muted">Active vendors</p>
          <p className="mt-1 text-2xl font-bold">{stats.activeVendorCount}</p>
          <p className="mt-1 text-xs text-muted">sold something in the last hour</p>
        </div>
        <div className="card p-5">
          <p className="text-xs uppercase tracking-wide text-muted">Top-up volume</p>
          <p className="mt-1 text-2xl font-bold">{formatCents(stats.totalTopUpCents, currency)}</p>
        </div>
        <div className="card p-5">
          <p className="text-xs uppercase tracking-wide text-muted">Spend volume</p>
          <p className="mt-1 text-2xl font-bold">{formatCents(stats.totalSpendCents, currency)}</p>
        </div>
        <div className="card p-5">
          <p className="text-xs uppercase tracking-wide text-muted">Unspent balance</p>
          <p className="mt-1 text-2xl font-bold">{formatCents(stats.unspentBalanceCents, currency)}</p>
        </div>
      </div>

      <h2 className="mb-3 mt-8 font-semibold">Check-in arrival curve</h2>
      <div className="card p-5">
        <LineSeries data={checkIns.map((p) => ({ label: p.hour, value: p.cumulative }))} />
        <p className="mt-3 text-xs text-muted">A flat line or sudden drop usually means a gate problem.</p>
      </div>

      <h2 className="mb-3 mt-8 font-semibold">Vendor sales by hour</h2>
      {vendorHourly.length === 0 ? (
        <div className="card p-8 text-center text-muted">No vendor sales yet.</div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="p-3 text-left text-xs font-medium uppercase tracking-wide text-muted">Vendor</th>
                {vendorHourly[0].hours.map((h) => (
                  <th key={h.hour} className="p-3 text-center text-xs font-medium uppercase tracking-wide text-muted">
                    {h.hour}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {vendorHourly.map((v) => (
                <tr key={v.vendorName}>
                  <td className="whitespace-nowrap p-3 font-medium">{v.vendorName}</td>
                  {v.hours.map((h) => (
                    <td key={h.hour} className="relative p-0 text-center">
                      {/* Count-based heat intensity — zero is fully transparent
                          (this app is dark-themed, so "white" for zero would
                          mean blending into the surface, not a literal white
                          swatch), scaling up to the accent color at the
                          grid's max count. */}
                      <div className="absolute inset-0 bg-accent" style={{ opacity: h.count > 0 ? (h.count / maxCellCount) * 0.85 : 0 }} />
                      <div className="relative px-2 py-2.5 text-xs" title={`${h.count} sale(s), ${formatCents(h.amountCents, currency)}`}>
                        {h.count >= 5 ? h.count : ""}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="mb-3 mt-8 font-semibold">Live activity</h2>
      {activity.length === 0 ? (
        <div className="card p-8 text-center text-muted">Nothing yet.</div>
      ) : (
        <div className="card divide-y divide-border">
          {activity.map((entry, i) => (
            <div key={i} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
              <div className="flex items-center gap-2">
                <span className={TYPE_STYLE[entry.type]}>{TYPE_LABEL[entry.type]}</span>
                <span className="font-mono text-xs text-muted">…{entry.codeLast4}</span>
                {(entry.vendorName || entry.sponsorName) && (
                  <span className="text-muted">{entry.vendorName ?? entry.sponsorName}</span>
                )}
              </div>
              <div className="flex items-center gap-3 text-xs text-muted">
                {entry.amountCents !== null && <span className="font-semibold text-foreground">{formatCents(entry.amountCents, currency)}</span>}
                <span>{new Date(entry.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
