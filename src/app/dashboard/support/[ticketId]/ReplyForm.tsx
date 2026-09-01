"use client";

import { useState } from "react";

// Extracted from a server-rendered inline form action into a client
// component so the "Draft with AI" button can own local state (drafting/
// draftError) and pre-fill the textarea before the organizer submits —
// the actual submit still goes through the existing replyAsOrganizer
// Server Action, passed down and bound with the ticket id (the sanctioned
// way to pass extra arguments to a Server Action from a Client Component).
export default function ReplyForm({
  ticketId,
  replyAction,
}: {
  ticketId: string;
  replyAction: (ticketId: string, formData: FormData) => Promise<void>;
}) {
  const [body, setBody] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);

  async function draftReply() {
    setDraftError(null);
    setDrafting(true);
    try {
      const res = await fetch("/api/ai/support/draft-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setDraftError(
          data?.reason === "AI_NOT_CONFIGURED"
            ? "AI assist isn't set up on this deployment yet."
            : "Couldn't draft a reply — try again."
        );
        return;
      }
      setBody(data.draft);
    } catch {
      setDraftError("Couldn't reach the server — check your connection.");
    } finally {
      setDrafting(false);
    }
  }

  return (
    <form action={replyAction.bind(null, ticketId)} className="card space-y-3 p-4">
      <div className="flex items-center justify-between">
        <p className="label !mb-0">Reply</p>
        <button
          type="button"
          className="text-xs font-medium text-accent-hover disabled:opacity-50"
          onClick={draftReply}
          disabled={drafting}
        >
          {drafting ? "Drafting…" : "Draft with AI"}
        </button>
      </div>
      <textarea
        name="body"
        className="input min-h-20"
        placeholder="Write a reply…"
        required
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      {draftError && <p className="text-xs text-danger">{draftError}</p>}
      <button type="submit" className="btn-primary text-sm">Send reply</button>
    </form>
  );
}
