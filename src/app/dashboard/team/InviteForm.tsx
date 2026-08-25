"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function InviteForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const res = await fetch("/api/organization/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    setSubmitting(false);
    if (!res.ok || !data.ok) {
      setError(data.error ?? "Couldn't send the invite.");
      return;
    }
    setSent(email);
    setEmail("");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-3 p-5">
      <h2 className="font-semibold">Invite a team member</h2>
      <p className="text-xs text-muted">
        They&apos;ll join as staff — able to manage events, vendors, and wallets, but not the team or payout account.
      </p>
      <div className="flex gap-2">
        <input
          type="email"
          required
          placeholder="teammate@example.com"
          className="input flex-1"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <button type="submit" disabled={submitting} className="btn-primary shrink-0">
          {submitting ? "Sending…" : "Send invite"}
        </button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {sent && <p className="text-sm text-ok">Invite sent to {sent}.</p>}
    </form>
  );
}
