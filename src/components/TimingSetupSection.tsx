"use client";

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import Link from "next/link";
import { db, newLocalId, type LocalTimingPoint } from "@/lib/db";
import { formatElapsed } from "@/lib/timing";
import { saveTimingPoints, startGun, type TimingPointInput } from "@/app/dashboard/events/[id]/timing/actions";

interface DraftPoint extends TimingPointInput {
  key: string; // React key — clientId once saved, a local temp id before
}

// Session 12's "Timing setup" section, embedded on the main event dashboard
// (src/app/dashboard/events/[id]/page.tsx) only when eventType ===
// "MARATHON". Kept as its own component so that page's own diff stays a
// single import + one conditional block, rather than growing an already
// large file with all of this state.
export default function TimingSetupSection({
  eventId,
  eventTitle,
  gunStartAt,
}: {
  eventId: string;
  eventTitle: string;
  gunStartAt: string | null;
}) {
  const savedPoints = useLiveQuery(
    async () => db.timingPoints.where("eventId").equals(eventId).sortBy("sequenceOrder"),
    [eventId]
  );

  const [drafts, setDrafts] = useState<DraftPoint[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [startingGun, setStartingGun] = useState(false);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (savedPoints && drafts === null) {
      setDrafts(
        savedPoints.map((p) => ({
          key: p.clientId ?? p.id,
          clientId: p.clientId ?? p.id,
          name: p.name,
          location: p.location,
          sequenceOrder: p.sequenceOrder,
          isStart: p.isStart,
          isFinish: p.isFinish,
          distanceMeters: p.distanceMeters,
        }))
      );
    }
  }, [savedPoints, drafts]);

  // Ticks the "gun elapsed" display once a second — only while it's shown.
  useEffect(() => {
    if (!gunStartAt) return;
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, [gunStartAt]);

  if (drafts === null) {
    return <div className="card mt-6 p-5 text-sm text-muted">Loading timing setup…</div>;
  }

  function addPoint() {
    const clientId = newLocalId();
    setDrafts((d) => [
      ...(d ?? []),
      {
        key: clientId,
        clientId,
        name: "",
        location: "",
        sequenceOrder: (d?.length ?? 0) * 10,
        isStart: (d?.length ?? 0) === 0,
        isFinish: false,
        distanceMeters: null,
      },
    ]);
  }

  function updatePoint(key: string, patch: Partial<DraftPoint>) {
    setDrafts((d) => (d ?? []).map((p) => (p.key === key ? { ...p, ...patch } : p)));
  }

  function removePoint(key: string) {
    setDrafts((d) => (d ?? []).filter((p) => p.key !== key));
  }

  // "Drag-to-reorder" without a new dependency or hand-rolled pointer DnD —
  // move-up/move-down buttons give the same reordering capability with far
  // less surface area, consistent with this codebase's "no library for one
  // use case" ethos (see csv.ts's own hand-rolled encoder).
  function move(key: string, direction: -1 | 1) {
    setDrafts((d) => {
      if (!d) return d;
      const i = d.findIndex((p) => p.key === key);
      const j = i + direction;
      if (i < 0 || j < 0 || j >= d.length) return d;
      const next = [...d];
      [next[i], next[j]] = [next[j], next[i]];
      return next.map((p, idx) => ({ ...p, sequenceOrder: idx * 10 }));
    });
  }

  async function save() {
    if (!drafts) return;
    setSaving(true);
    try {
      const updated = await saveTimingPoints(eventId, drafts);
      await db.timingPoints.where("eventId").equals(eventId).delete();
      await db.timingPoints.bulkPut(
        updated.map(
          (p): LocalTimingPoint => ({
            id: p.id,
            clientId: p.clientId,
            eventId: p.eventId,
            name: p.name,
            location: p.location,
            sequenceOrder: p.sequenceOrder,
            isStart: p.isStart,
            isFinish: p.isFinish,
            distanceMeters: p.distanceMeters,
            createdAt: p.createdAt.toISOString(),
            updatedAt: p.updatedAt.toISOString(),
          })
        )
      );
      setDrafts(null); // reload from the now-authoritative saved list
    } catch {
      alert("Couldn't save timing points. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function fireStartGun() {
    if (!confirm(`Start the gun for "${eventTitle}" now? This cannot be undone.`)) return;
    setStartingGun(true);
    try {
      const newGunStartAt = await startGun(eventId);
      await db.events.update(eventId, { gunStartAt: newGunStartAt });
    } catch (err) {
      alert(err instanceof Error ? err.message : "Couldn't start the gun.");
    } finally {
      setStartingGun(false);
    }
  }

  const elapsedSeconds = gunStartAt ? Math.max(0, Math.floor((now.getTime() - new Date(gunStartAt).getTime()) / 1000)) : null;

  return (
    <div className="card mt-6 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold">Timing setup</h2>
        <Link href={`/scan/${eventId}/timing`} className="text-xs font-medium text-accent-hover hover:underline">
          Open timing scanner ↗
        </Link>
      </div>

      {elapsedSeconds !== null ? (
        <div className="mt-3 rounded-xl border border-ok/40 bg-ok/10 p-4 text-center">
          <p className="text-xs uppercase tracking-wide text-muted">Gun time elapsed</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{formatElapsed(elapsedSeconds)}</p>
        </div>
      ) : (
        <button
          className="btn-primary mt-3 w-full disabled:opacity-50"
          disabled={startingGun || drafts.length === 0}
          onClick={fireStartGun}
        >
          {startingGun ? "Starting…" : "Start gun"}
        </button>
      )}

      <div className="mt-4 space-y-2">
        {drafts.map((p, i) => (
          <div key={p.key} className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3">
            <span className="w-5 text-center text-xs text-muted">{i + 1}</span>
            <input
              className="input !h-9 flex-1"
              placeholder="Name (e.g. 10km)"
              value={p.name}
              onChange={(e) => updatePoint(p.key, { name: e.target.value })}
            />
            <input
              className="input !h-9 flex-1"
              placeholder="Location (optional)"
              value={p.location}
              onChange={(e) => updatePoint(p.key, { location: e.target.value })}
            />
            <input
              className="input !h-9 w-28"
              type="number"
              min="0"
              placeholder="Distance (m)"
              value={p.distanceMeters ?? ""}
              onChange={(e) => updatePoint(p.key, { distanceMeters: e.target.value ? Number(e.target.value) : null })}
            />
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={p.isStart} onChange={(e) => updatePoint(p.key, { isStart: e.target.checked })} />
              Start
            </label>
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={p.isFinish} onChange={(e) => updatePoint(p.key, { isFinish: e.target.checked })} />
              Finish
            </label>
            <div className="flex gap-1">
              <button type="button" className="text-xs text-muted hover:text-foreground disabled:opacity-30" disabled={i === 0} onClick={() => move(p.key, -1)}>
                ↑
              </button>
              <button
                type="button"
                className="text-xs text-muted hover:text-foreground disabled:opacity-30"
                disabled={i === drafts.length - 1}
                onClick={() => move(p.key, 1)}
              >
                ↓
              </button>
              <button type="button" className="text-xs text-danger hover:underline" onClick={() => removePoint(p.key)}>
                Remove
              </button>
            </div>
          </div>
        ))}
        {drafts.length === 0 && <p className="text-sm text-muted">No timing points yet — add Start and Finish at minimum.</p>}
      </div>

      <div className="mt-3 flex gap-2">
        <button type="button" className="btn-secondary" onClick={addPoint}>
          + Add timing point
        </button>
        <button type="button" className="btn-primary disabled:opacity-50" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save timing points"}
        </button>
      </div>
    </div>
  );
}
