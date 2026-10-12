"use client";

import { useState } from "react";

// Posts to the same /api/leads route the chaap.africa marketing mockup
// already used cross-origin (see that route's own CORS comment) — now
// same-origin, since this form lives in the app itself, but the route
// needed no changes: https://chaap.africa is already in its allow-list.
export default function MarketingLeadForm() {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [eventName, setEventName] = useState("");
  const [attendance, setAttendance] = useState("Under 2,000");
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setStatus(null);
    try {
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          phone,
          email: email.trim() || undefined,
          eventName: eventName.trim() || undefined,
          expectedAttendance: attendance,
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        setStatus({ ok: true, message: "Thanks — we'll be in touch shortly." });
        setName("");
        setPhone("");
        setEmail("");
        setEventName("");
      } else if (res.status === 429) {
        setStatus({ ok: false, message: "Too many requests — please try again shortly, or email hello@chaap.africa." });
      } else {
        setStatus({ ok: false, message: data?.error ?? "Something went wrong — please email hello@chaap.africa instead." });
      }
    } catch {
      setStatus({ ok: false, message: "Couldn't reach the server — please email hello@chaap.africa instead." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-4 p-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="lead-name">Your name</label>
          <input
            id="lead-name"
            required
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="lead-phone">Phone or WhatsApp</label>
          <input
            id="lead-phone"
            type="tel"
            required
            placeholder="+255"
            className="input"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
      </div>
      <div>
        <label className="label" htmlFor="lead-email">Email</label>
        <input
          id="lead-email"
          type="email"
          placeholder="you@company.co.tz"
          className="input"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div>
        <label className="label" htmlFor="lead-event">Event name and date</label>
        <input
          id="lead-event"
          placeholder="e.g. City Music Festival, March 2027"
          className="input"
          value={eventName}
          onChange={(e) => setEventName(e.target.value)}
        />
      </div>
      <div>
        <label className="label" htmlFor="lead-attendance">Expected attendance</label>
        <select
          id="lead-attendance"
          className="input"
          value={attendance}
          onChange={(e) => setAttendance(e.target.value)}
        >
          <option>Under 2,000</option>
          <option>2,000 – 10,000</option>
          <option>10,000 – 30,000</option>
          <option>30,000+</option>
        </select>
      </div>
      <button type="submit" disabled={submitting} className="btn-primary w-full">
        {submitting ? "Sending…" : "Request a demo"}
      </button>
      {status && (
        <p role="status" aria-live="polite" className={`text-sm ${status.ok ? "text-ok" : "text-danger"}`}>
          {status.message}
        </p>
      )}
    </form>
  );
}
