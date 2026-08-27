"use client";

import { useState } from "react";
import { previewAudience, sendBroadcastAction } from "./actions";

interface EventOption {
  id: string;
  title: string;
  ticketTypes: { id: string; name: string }[];
}

export default function BroadcastComposer({ events }: { events: EventOption[] }) {
  const [eventId, setEventId] = useState(events[0]?.id ?? "");
  const [ticketTypeId, setTicketTypeId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedEvent = events.find((e) => e.id === eventId);

  async function handlePreview() {
    if (!eventId) return;
    setPreviewing(true);
    setError(null);
    try {
      const count = await previewAudience(eventId, ticketTypeId || null);
      setPreviewCount(count);
    } catch {
      setError("Couldn't preview recipients.");
    } finally {
      setPreviewing(false);
    }
  }

  async function handleSend() {
    if (!eventId || !subject.trim() || !body.trim()) return;
    setSending(true);
    setError(null);
    try {
      const result = await sendBroadcastAction(eventId, ticketTypeId || null, subject.trim(), body.trim());
      setSent(`Sent to ${result.recipientCount} customer${result.recipientCount === 1 ? "" : "s"}.`);
      setSubject("");
      setBody("");
      setPreviewCount(null);
    } catch {
      setError("Couldn't send the broadcast.");
    } finally {
      setSending(false);
    }
  }

  if (events.length === 0) {
    return <div className="card p-6 text-center text-sm text-muted">Create an event first.</div>;
  }

  return (
    <div className="card space-y-4 p-5">
      <div>
        <label className="label" htmlFor="broadcast-event">Event</label>
        <select
          id="broadcast-event"
          className="input"
          value={eventId}
          onChange={(e) => {
            setEventId(e.target.value);
            setTicketTypeId("");
            setPreviewCount(null);
          }}
        >
          {events.map((e) => (
            <option key={e.id} value={e.id}>{e.title}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="label" htmlFor="broadcast-ticket-type">Ticket type (optional)</label>
        <select
          id="broadcast-ticket-type"
          className="input"
          value={ticketTypeId}
          onChange={(e) => {
            setTicketTypeId(e.target.value);
            setPreviewCount(null);
          }}
        >
          <option value="">Everyone who bought a ticket to this event</option>
          {selectedEvent?.ticketTypes.map((tt) => (
            <option key={tt.id} value={tt.id}>{tt.name} only</option>
          ))}
        </select>
      </div>

      <div>
        <label className="label" htmlFor="broadcast-subject">Subject</label>
        <input
          id="broadcast-subject"
          className="input"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      </div>

      <div>
        <label className="label" htmlFor="broadcast-body">Message</label>
        <textarea
          id="broadcast-body"
          className="input min-h-32"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handlePreview}
          disabled={previewing || !eventId}
          className="btn-secondary text-sm"
        >
          {previewing ? "Checking…" : "Preview recipients"}
        </button>
        {previewCount !== null && (
          <span className="text-sm text-muted">
            {previewCount} recipient{previewCount === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={handleSend}
        disabled={sending || !eventId || !subject.trim() || !body.trim()}
        className="btn-primary w-full"
      >
        {sending ? "Sending…" : "Send broadcast"}
      </button>

      {error && <p className="text-sm text-danger">{error}</p>}
      {sent && <p className="text-sm text-ok">{sent}</p>}
    </div>
  );
}
