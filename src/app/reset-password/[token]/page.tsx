"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

export default function ResetPasswordPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    setLoading(true);
    const res = await fetch("/api/password-reset/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok || !data.ok) {
      setError(data.error ?? "Something went wrong.");
      return;
    }
    setDone(true);
    setTimeout(() => router.push("/login"), 2000);
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 py-12">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/icon.svg" alt="" className="mb-4 h-12 w-12 rounded-xl" />
      <h1 className="mb-1 text-2xl font-bold">Set a new password</h1>

      {done ? (
        <div className="card p-6 text-sm">
          <p className="text-ok">Password updated — redirecting to login…</p>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="card space-y-4 p-6">
          <div>
            <label className="label" htmlFor="password">New password</label>
            <input
              id="password"
              type="password"
              required
              minLength={8}
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="confirmPassword">Confirm password</label>
            <input
              id="confirmPassword"
              type="password"
              required
              minLength={8}
              className="input"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <button type="submit" disabled={loading} className="btn-primary w-full">
            {loading ? "Saving…" : "Update password"}
          </button>
        </form>
      )}

      <p className="mt-6 text-center text-sm text-muted">
        <Link href="/login" className="font-medium text-accent-hover">Back to login</Link>
      </p>
    </div>
  );
}
