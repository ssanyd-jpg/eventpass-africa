"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { useAppSession } from "@/lib/use-app-session";
import { pullFromServer } from "@/lib/sync-engine";

interface TransferInfo {
  status: string;
  expired: boolean;
  toEmail: string;
  hasAccount: boolean;
  eventTitle: string;
  ticketTypeName: string;
}

// Mirrors /team/accept/[token] (see src/app/team/accept/[token]/page.tsx)
// with one deliberate deviation, per the user-confirmed scope decision: if
// toEmail already has an account, this behaves identically to the team
// invite flow (sign in with a matching email, then accept). If it doesn't,
// this page instead offers an inline sign-up (name + password, email
// locked to toEmail) — a gifted ticket recipient shouldn't have to already
// be a platform member the way a team invite reasonably expects.
export default function AcceptTicketTransferPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const { user, status: sessionStatus } = useAppSession();

  const [info, setInfo] = useState<TransferInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    fetch(`/api/tickets/transfer/${token}`)
      .then((res) => res.json())
      .then((data) => {
        if (!data.ok) {
          setLoadError(data.error ?? "This transfer link is invalid.");
          return;
        }
        setInfo(data);
      })
      .catch(() => setLoadError("Couldn't load this transfer link."));
  }, [token]);

  async function acceptNow() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/tickets/transfer/${token}`, { method: "POST" });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setError(data.error ?? "Something went wrong.");
      setBusy(false);
      return;
    }
    setAccepted(true);
    await pullFromServer();
    setTimeout(() => router.push("/account/tickets"), 1500);
  }

  async function signUpThenAccept(e: React.FormEvent) {
    e.preventDefault();
    if (!info) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email: info.toEmail, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Couldn't create your account.");
        setBusy(false);
        return;
      }
      const signInRes = await signIn("credentials", { redirect: false, email: info.toEmail, password });
      if (signInRes?.error) {
        setError("Account created, but sign-in failed — try signing in manually.");
        setBusy(false);
        return;
      }
      await acceptNow();
    } catch {
      setError("Couldn't reach the server.");
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 py-12 text-center">
        <p className="text-sm text-danger">{loadError}</p>
      </div>
    );
  }

  if (!info || sessionStatus === "loading") return null;

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 py-12">
      <h1 className="mb-1 text-2xl font-bold">You&apos;ve been sent a ticket</h1>
      <p className="mb-6 text-sm text-muted">
        {info.ticketTypeName} — {info.eventTitle}
      </p>

      {accepted ? (
        <div className="card p-6 text-sm">
          <p className="text-ok">Ticket accepted — redirecting to your tickets…</p>
        </div>
      ) : info.expired || info.status !== "PENDING" ? (
        <div className="card p-6 text-sm text-danger">
          This transfer link is no longer valid
          {info.status === "CANCELLED" && " — the sender cancelled it"}
          {info.status === "ACCEPTED" && " — it's already been accepted"}
          {info.expired && info.status === "PENDING" && " — it has expired"}.
        </div>
      ) : user ? (
        user.email?.toLowerCase() === info.toEmail.toLowerCase() ? (
          <div className="card space-y-4 p-6">
            <p className="text-sm text-muted">
              Accept this ticket as <span className="font-medium text-foreground">{user.email}</span>.
            </p>
            {error && <p className="text-sm text-danger">{error}</p>}
            <button type="button" disabled={busy} className="btn-primary w-full" onClick={acceptNow}>
              {busy ? "Accepting…" : "Accept ticket"}
            </button>
          </div>
        ) : (
          <div className="card p-6 text-sm text-danger">
            This ticket was sent to {info.toEmail}, but you&apos;re signed in as {user.email}.
          </div>
        )
      ) : info.hasAccount ? (
        <div className="card space-y-4 p-6 text-center">
          <p className="text-sm text-muted">Sign in as {info.toEmail} to accept this ticket.</p>
          <Link href={`/login?callbackUrl=/tickets/transfer/${token}`} className="btn-primary inline-flex w-full justify-center">
            Sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={signUpThenAccept} className="card space-y-4 p-6">
          <p className="text-sm text-muted">Create an account to accept this ticket.</p>
          <div>
            <label className="label" htmlFor="email">Email</label>
            <input id="email" className="input" value={info.toEmail} disabled />
          </div>
          <div>
            <label className="label" htmlFor="name">Full name</label>
            <input id="name" required className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              required
              minLength={8}
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className="mt-1 text-xs text-muted">At least 8 characters.</p>
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <button type="submit" disabled={busy} className="btn-primary w-full">
            {busy ? "Creating account…" : "Create account & accept"}
          </button>
        </form>
      )}
    </div>
  );
}
