"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useAppSession } from "@/lib/use-app-session";
import { formatCents } from "@/lib/format";
import LineSeries from "@/components/charts/LineSeries";
import {
  computeForecast,
  type ForecastInputs,
  type ScenarioKey,
  type TicketTier,
} from "@/lib/revenue-forecast";
import { saveEventForecast } from "./actions";

const DEFAULT_ADOPTION = 0.6;
const DEFAULT_AVG_SPEND_CENTS = 1_500_000; // TZS 15,000

interface ForecastPayload {
  eventId: string;
  eventTitle: string;
  currency: string;
  ticketTiers: (TicketTier & { name: string })[];
  defaultExpectedAttendance: number;
  savedForecast: {
    expectedAttendance: number;
    cashlessAdoptionRate: number;
    avgSpendCents: number;
    durationDays: number;
    savedAt: string;
  } | null;
  historical: {
    eventCount: number;
    avgCashlessAdoptionRate: number | null;
    avgSpendPerHeadCents: number | null;
  };
}

const SCENARIO_ORDER: ScenarioKey[] = ["low", "base", "high"];
const SCENARIO_ACCENT: Record<ScenarioKey, string> = {
  low: "border-warn/40",
  base: "border-accent/50",
  high: "border-ok/40",
};

export default function ForecastPage() {
  const { id: rawId } = useParams<{ id: string }>();
  const eventId = decodeURIComponent(rawId);
  const router = useRouter();
  const { user } = useAppSession();

  useEffect(() => {
    if (user?.organizationRole === "GATE_CREW") router.replace("/dashboard");
  }, [user, router]);

  const [data, setData] = useState<ForecastPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const [attendance, setAttendance] = useState("");
  const [adoptionPct, setAdoptionPct] = useState(Math.round(DEFAULT_ADOPTION * 100));
  const [avgSpendMajor, setAvgSpendMajor] = useState(String(DEFAULT_AVG_SPEND_CENTS / 100));
  const [durationDays, setDurationDays] = useState("1");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/dashboard/events/${eventId}/forecast`, { cache: "no-store" });
      const body = await res.json();
      if (!body.ok) {
        setError(body.reason === "NOT_FOUND" ? "Event not found." : "Couldn't load the forecast.");
        return;
      }
      setError(null);
      setData(body);

      const saved = body.savedForecast as ForecastPayload["savedForecast"];
      if (saved) {
        setAttendance(String(saved.expectedAttendance));
        setAdoptionPct(Math.round(saved.cashlessAdoptionRate * 100));
        setAvgSpendMajor(String(saved.avgSpendCents / 100));
        setDurationDays(String(saved.durationDays));
        setSavedAt(saved.savedAt);
      } else {
        setAttendance(String(body.defaultExpectedAttendance));
      }
    } catch {
      setError((prev) => prev ?? "Couldn't load the forecast.");
    }
  }, [eventId]);

  useEffect(() => {
    load();
  }, [load]);

  const inputs: ForecastInputs = useMemo(
    () => ({
      expectedAttendance: Math.max(0, Math.round(parseFloat(attendance) || 0)),
      cashlessAdoptionRate: adoptionPct / 100,
      avgSpendCents: Math.max(0, Math.round((parseFloat(avgSpendMajor) || 0) * 100)),
      durationDays: Math.max(1, Math.round(parseFloat(durationDays) || 1)),
    }),
    [attendance, adoptionPct, avgSpendMajor, durationDays]
  );

  const forecast = useMemo(
    () => (data ? computeForecast(inputs, data.ticketTiers) : null),
    [data, inputs]
  );

  async function onSave() {
    setSaving(true);
    try {
      await saveEventForecast({
        eventId,
        expectedAttendance: inputs.expectedAttendance,
        cashlessAdoptionRate: inputs.cashlessAdoptionRate,
        avgSpendCents: inputs.avgSpendCents,
        durationDays: inputs.durationDays,
      });
      setSavedAt(new Date().toISOString());
    } catch {
      alert("Couldn't save the forecast. Try again.");
    } finally {
      setSaving(false);
    }
  }

  function applyHistoricalDefaults() {
    if (!data) return;
    if (data.historical.avgCashlessAdoptionRate != null) {
      setAdoptionPct(Math.round(data.historical.avgCashlessAdoptionRate * 100));
    }
    if (data.historical.avgSpendPerHeadCents != null) {
      setAvgSpendMajor(String(Math.round(data.historical.avgSpendPerHeadCents / 100)));
    }
  }

  if (user?.organizationRole === "GATE_CREW") return null;

  if (!data && error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center">
        <p className="font-semibold">{error}</p>
        <Link href={`/dashboard/events/${eventId}`} className="btn-secondary mt-6 inline-flex">Back to event</Link>
      </div>
    );
  }
  if (!data || !forecast) {
    return <div className="mx-auto max-w-3xl px-4 py-16 text-center text-muted">Loading…</div>;
  }

  const c = data.currency;
  const hist = data.historical;

  return (
    <div className="mx-auto max-w-5xl px-4 pb-20 pt-8 sm:px-6">
      <Link href={`/dashboard/events/${eventId}`} className="text-sm text-muted hover:text-foreground">
        ← {data.eventTitle}
      </Link>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Revenue forecast</h1>
        <div className="flex items-center gap-3">
          {savedAt && <span className="text-xs text-muted">Saved {new Date(savedAt).toLocaleString()}</span>}
          <button className="btn-primary disabled:opacity-50" disabled={saving} onClick={onSave}>
            {saving ? "Saving…" : "Save forecast"}
          </button>
        </div>
      </div>

      {/* ---------- inputs ---------- */}
      <div className="card mt-6 grid grid-cols-1 gap-5 p-5 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="attendance">Expected attendance</label>
          <input
            id="attendance"
            type="number"
            min="0"
            className="input"
            value={attendance}
            onChange={(e) => setAttendance(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted">Default: total ticket capacity ({data.defaultExpectedAttendance.toLocaleString()})</p>
        </div>
        <div>
          <label className="label" htmlFor="adoption">Cashless adoption rate — {adoptionPct}%</label>
          <input
            id="adoption"
            type="range"
            min="0"
            max="100"
            className="w-full"
            value={adoptionPct}
            onChange={(e) => setAdoptionPct(Number(e.target.value))}
          />
          <p className="mt-1 text-xs text-muted">Share of attendees who load a wallet</p>
        </div>
        <div>
          <label className="label" htmlFor="avgspend">Average spend per cashless attendee ({c})</label>
          <input
            id="avgspend"
            type="number"
            min="0"
            step="500"
            className="input"
            value={avgSpendMajor}
            onChange={(e) => setAvgSpendMajor(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="duration">Event duration (days)</label>
          <input
            id="duration"
            type="number"
            min="1"
            className="input"
            value={durationDays}
            onChange={(e) => setDurationDays(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted">The event record only has a start date — set the run length here.</p>
        </div>
      </div>

      {/* ---------- historical comparison ---------- */}
      {hist.avgCashlessAdoptionRate != null && (
        <div className="mt-5 rounded-xl border border-border bg-accent/5 p-4 text-sm">
          <p className="font-medium">From your {hist.eventCount} past {hist.eventCount === 1 ? "event" : "events"}:</p>
          <p className="mt-1 text-muted">
            Cashless adoption averaged <strong>{Math.round(hist.avgCashlessAdoptionRate * 100)}%</strong>
            {hist.avgSpendPerHeadCents != null && (
              <> · spend per cashless head averaged <strong>{formatCents(hist.avgSpendPerHeadCents, c)}</strong></>
            )}
          </p>
          <button className="mt-2 text-xs font-medium text-accent-hover hover:underline" onClick={applyHistoricalDefaults}>
            Use these as my inputs
          </button>
        </div>
      )}

      {/* ---------- scenario cards ---------- */}
      <div className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-3">
        {SCENARIO_ORDER.map((key) => {
          const s = forecast.scenarios[key];
          return (
            <div key={key} className={`card border-2 p-5 ${SCENARIO_ACCENT[key]}`}>
              <p className="text-sm font-bold uppercase tracking-wide">{s.label}</p>
              <p className="mt-1 text-2xl font-extrabold tabular-nums">{formatCents(s.totalRevenueCents, c)}</p>
              <p className="text-xs text-muted">
                {s.projectedAttendance.toLocaleString()} attendees · {s.cashlessAttendees.toLocaleString()} cashless
              </p>
              <dl className="mt-4 space-y-1.5 text-sm">
                <Row label="Ticket revenue" value={formatCents(s.ticketRevenueCents, c)} />
                <Row label="Cashless top-up volume" value={formatCents(s.topUpVolumeCents, c)} />
                <Row label="Cashless spend" value={formatCents(s.cashlessSpendCents, c)} />
                <Row label="Net breakage (5%)" value={formatCents(s.netBreakageCents, c)} />
                <Row label="Platform revenue (2%)" value={formatCents(s.platformRevenueCents, c)} />
              </dl>
            </div>
          );
        })}
      </div>

      {/* ---------- daily curve ---------- */}
      <h2 className="mb-3 mt-10 font-semibold">Projected daily revenue (Base scenario)</h2>
      <div className="card p-5">
        <LineSeries data={forecast.dailyCurve.map((p) => ({ label: p.label, value: Math.round(p.value / 100) }))} />
        <p className="mt-3 text-xs text-muted">
          {inputs.durationDays === 1
            ? "Single-day event — the full projected total lands on one day."
            : `Spread across ${inputs.durationDays} days, ramping toward the middle of the run.`}
        </p>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
