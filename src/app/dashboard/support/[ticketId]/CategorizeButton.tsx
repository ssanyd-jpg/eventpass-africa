"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// On-demand only (per this pass's cost discipline — never auto-called on
// ticket creation). The result persists server-side onto
// SupportTicket.aiCategory/aiPriority (see /api/ai/support/categorize), so
// router.refresh() after a successful call is enough to pick it up — no
// local state needed once it's set.
export default function CategorizeButton({ ticketId }: { ticketId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function suggest() {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/ai/support/categorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setError(
          data?.reason === "AI_NOT_CONFIGURED"
            ? "AI assist isn't set up on this deployment yet."
            : "Couldn't suggest a category — try again."
        );
        return;
      }
      router.refresh();
    } catch {
      setError("Couldn't reach the server — check your connection.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        className="pill text-accent-hover hover:border-accent disabled:opacity-50"
        onClick={suggest}
        disabled={loading}
      >
        {loading ? "Suggesting…" : "Suggest category"}
      </button>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}
