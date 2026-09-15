"use client";

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import Link from "next/link";
import { db, newLocalId, type LocalConferenceSession } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { saveConferenceSessions, type ConferenceSessionInput } from "@/app/dashboard/events/[id]/sessions/actions";

interface DraftSession extends ConferenceSessionInput {
  key: string; // React key — clientId once saved, a local temp id before
}

// Session 19's "Sessions" section, embedded on the main event dashboard
// (src/app/dashboard/events/[id]/page.tsx) only when
// hasFeature(event.eventType, "sessionCheckIn") — see src/lib/event-modes.ts.
// Same "own component, one import + one conditional block" discipline
// TimingSetupSection already established for MARATHON.
export default function ConferenceSessionsSection({ eventId }: { eventId: string }) {
  const savedSessions = useLiveQuery(
    async () => db.conferenceSessions.where("eventId").equals(eventId).sortBy("startsAt"),
    [eventId]
  );

  const [drafts, setDrafts] = useState<DraftSession[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (savedSessions && drafts === null) {
      setDrafts(
        savedSessions.map((s) => ({
          key: s.clientId ?? s.id,
          clientId: s.clientId ?? s.id,
          name: s.name,
          speaker: s.speaker,
          location: s.location,
          startsAt: s.startsAt.slice(0, 16), // datetime-local input value
          endsAt: s.endsAt.slice(0, 16),
        }))
      );
    }
  }, [savedSessions, drafts]);

  if (drafts === null) {
    return <div className="card mt-6 p-5 text-sm text-muted">Loading sessions…</div>;
  }

  function addSession() {
    const clientId = newLocalId();
    setDrafts((d) => [
      ...(d ?? []),
      { key: clientId, clientId, name: "", speaker: "", location: "", startsAt: "", endsAt: "" },
    ]);
  }

  function updateSession(key: string, patch: Partial<DraftSession>) {
    setDrafts((d) => (d ?? []).map((s) => (s.key === key ? { ...s, ...patch } : s)));
  }

  function removeSession(key: string) {
    setDrafts((d) => (d ?? []).filter((s) => s.key !== key));
  }

  async function save() {
    if (!drafts) return;
    setSaving(true);
    try {
      const updated = await saveConferenceSessions(
        eventId,
        drafts.map((d) => ({
          clientId: d.clientId,
          name: d.name,
          speaker: d.speaker,
          location: d.location,
          startsAt: d.startsAt,
          endsAt: d.endsAt,
        }))
      );
      await db.conferenceSessions.where("eventId").equals(eventId).delete();
      await db.conferenceSessions.bulkPut(
        updated.map(
          (s): LocalConferenceSession => ({
            id: s.id,
            clientId: s.clientId,
            eventId: s.eventId,
            name: s.name,
            speaker: s.speaker,
            location: s.location,
            startsAt: s.startsAt.toISOString(),
            endsAt: s.endsAt.toISOString(),
            attendanceCount: savedSessions?.find((p) => p.id === s.id)?.attendanceCount ?? 0,
            createdAt: s.createdAt.toISOString(),
            updatedAt: s.updatedAt.toISOString(),
          })
        )
      );
      setDrafts(null); // reload from the now-authoritative saved list
    } catch {
      alert("Couldn't save sessions. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card mt-6 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold">Sessions</h2>
        <Link href={`/scan/${eventId}/session`} className="text-xs font-medium text-accent-hover hover:underline">
          Open session scanner ↗
        </Link>
      </div>

      <div className="mt-4 space-y-2">
        {drafts.map((s) => (
          <div key={s.key} className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3">
            <input
              className="input !h-9 flex-1"
              placeholder="Session name"
              value={s.name}
              onChange={(e) => updateSession(s.key, { name: e.target.value })}
            />
            <input
              className="input !h-9 flex-1"
              placeholder="Speaker (optional)"
              value={s.speaker ?? ""}
              onChange={(e) => updateSession(s.key, { speaker: e.target.value })}
            />
            <input
              className="input !h-9 flex-1"
              placeholder="Room/location (optional)"
              value={s.location ?? ""}
              onChange={(e) => updateSession(s.key, { location: e.target.value })}
            />
            <input
              className="input !h-9 w-48"
              type="datetime-local"
              value={s.startsAt}
              onChange={(e) => updateSession(s.key, { startsAt: e.target.value })}
            />
            <input
              className="input !h-9 w-48"
              type="datetime-local"
              value={s.endsAt}
              onChange={(e) => updateSession(s.key, { endsAt: e.target.value })}
            />
            <button type="button" className="text-xs text-danger hover:underline" onClick={() => removeSession(s.key)}>
              Remove
            </button>
          </div>
        ))}
        {drafts.length === 0 && <p className="text-sm text-muted">No sessions yet — add your first one below.</p>}
      </div>

      <div className="mt-3 flex gap-2">
        <button type="button" className="btn-secondary" onClick={addSession}>
          + Add session
        </button>
        <button type="button" className="btn-primary disabled:opacity-50" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save sessions"}
        </button>
      </div>

      {(savedSessions ?? []).length > 0 && (
        <div className="mt-4 divide-y divide-border border-t border-border pt-3 text-sm">
          {(savedSessions ?? []).map((s) => (
            <div key={s.id} className="flex items-center justify-between py-2">
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
    </div>
  );
}
