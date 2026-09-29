"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { linkEventAction } from "../actions";
import { formatDate } from "@/lib/format";

interface LinkableEvent {
  id: string;
  title: string;
  startsAt: string;
}

export default function EventLinker({ seasonPassId, linkableEvents }: { seasonPassId: string; linkableEvents: LinkableEvent[] }) {
  const router = useRouter();
  const [eventId, setEventId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onLink(e: React.FormEvent) {
    e.preventDefault();
    if (!eventId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await linkEventAction(seasonPassId, eventId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEventId("");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (linkableEvents.length === 0) {
    return <p className="text-sm text-muted">Every one of your events is already linked to this pass.</p>;
  }

  return (
    <form onSubmit={onLink} className="flex flex-wrap items-end gap-3">
      <div className="min-w-[220px] flex-1">
        <label className="label" htmlFor={`link-event-${seasonPassId}`}>Link an event</label>
        <select id={`link-event-${seasonPassId}`} className="input" value={eventId} onChange={(e) => setEventId(e.target.value)}>
          <option value="">Select an event…</option>
          {linkableEvents.map((e) => (
            <option key={e.id} value={e.id}>{e.title} — {formatDate(e.startsAt)}</option>
          ))}
        </select>
      </div>
      <button type="submit" className="btn-secondary" disabled={busy || !eventId}>
        {busy ? "Linking…" : "Link event"}
      </button>
      {error && <p className="w-full text-sm text-danger">{error}</p>}
    </form>
  );
}
