"use client";

import { useState } from "react";

// No password — a Sponsor isn't a User (see src/lib/sponsor-auth.ts). Same
// event-code + contact-email lookup as the vendor login page, and the same
// generic confirmation regardless of whether anything actually matched.
export default function SponsorLoginPage() {
  const [email, setEmail] = useState("");
  const [eventCode, setEventCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await fetch("/api/sponsor/magic-link/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), eventCode: eventCode.trim() }),
      });
    } finally {
      setSubmitting(false);
      setSent(true);
    }
  }

  return (
    <div className="mx-auto flex min-h-[80vh] max-w-sm flex-col justify-center px-5 py-10">
      <h1 className="text-3xl font-bold">Sponsor sign in</h1>
      <p className="mt-2 text-base text-muted">We&rsquo;ll email you a link to your live zone dashboard — no password needed.</p>

      {sent ? (
        <div className="card mt-6 border-ok/40 bg-ok/10 p-5 text-center text-lg">
          If that email is registered for that event, a sign-in link is on its way. It expires in 24 hours or as soon as you use it.
        </div>
      ) : (
        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <div>
            <label className="label text-base" htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              required
              autoFocus
              className="input !h-14 !text-lg"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@sponsor.com"
            />
          </div>
          <div>
            <label className="label text-base" htmlFor="eventCode">Event code</label>
            <input
              id="eventCode"
              required
              className="input !h-14 !text-lg"
              value={eventCode}
              onChange={(e) => setEventCode(e.target.value)}
              placeholder="From the organiser"
            />
          </div>
          <button type="submit" disabled={submitting} className="btn-primary !h-14 w-full !text-lg">
            {submitting ? "Sending…" : "Send my link"}
          </button>
        </form>
      )}
    </div>
  );
}
