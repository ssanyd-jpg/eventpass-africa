"use client";

import { useState } from "react";
import Link from "next/link";
import { useOnlineStatus } from "@/lib/sync-engine";

export default function ForgotPasswordPage() {
  const online = useOnlineStatus();
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    await fetch("/api/password-reset/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    }).catch(() => {});
    setLoading(false);
    setSubmitted(true);
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 py-12">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/icon.svg" alt="" className="mb-4 h-12 w-12 rounded-xl" />
      <h1 className="mb-1 text-2xl font-bold">Reset your password</h1>
      <p className="mb-6 text-sm text-muted">
        Enter your account email and we&apos;ll send a reset link.
      </p>

      {!online && (
        <p className="mb-4 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
          You&apos;re offline. Requesting a reset needs a connection.
        </p>
      )}

      {submitted ? (
        <div className="card p-6 text-sm">
          <p>
            If an account exists for that email, a reset link has been sent.
            During this pilot, no email provider is connected yet — an admin
            can find the link in the notification log at <code>/admin</code>{" "}
            and relay it to you.
          </p>
          <Link href="/login" className="btn-secondary mt-4 inline-flex">Back to login</Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="card space-y-4 p-6">
          <div>
            <label className="label" htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              required
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <button type="submit" disabled={loading} className="btn-primary w-full">
            {loading ? "Sending…" : "Send reset link"}
          </button>
        </form>
      )}

      <p className="mt-6 text-center text-sm text-muted">
        <Link href="/login" className="font-medium text-accent-hover">Back to login</Link>
      </p>
    </div>
  );
}
