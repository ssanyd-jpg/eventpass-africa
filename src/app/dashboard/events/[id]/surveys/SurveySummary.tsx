"use client";

import { useState } from "react";

// On-demand "Summarize responses" for a TEXT survey question — augments
// (never replaces) the existing raw response list, since organizers may
// still want to read verbatim quotes. Not persisted server-side; re-fetches
// on every click, same as the event-description drafter.
export default function SurveySummary({ eventId, questionId }: { eventId: string; questionId: string }) {
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function summarize() {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/ai/survey-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, questionId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setError(
          data?.reason === "AI_NOT_CONFIGURED"
            ? "AI assist isn't set up on this deployment yet."
            : data?.reason === "TOO_FEW_RESPONSES"
            ? data.message
            : "Couldn't summarize responses — try again."
        );
        return;
      }
      setSummary(data.summary);
    } catch {
      setError("Couldn't reach the server — check your connection.");
    } finally {
      setLoading(false);
    }
  }

  if (summary) {
    return (
      <div className="mb-3 rounded-lg border border-accent/40 bg-accent-soft p-3 text-sm">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-accent-hover">AI summary</p>
        <p>{summary}</p>
      </div>
    );
  }

  return (
    <div className="mb-3">
      <button
        type="button"
        className="text-xs font-medium text-accent-hover disabled:opacity-50"
        onClick={summarize}
        disabled={loading}
      >
        {loading ? "Summarizing…" : "Summarize responses"}
      </button>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}
