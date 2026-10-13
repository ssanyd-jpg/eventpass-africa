"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { useAppSession } from "@/lib/use-app-session";
import { formatCents } from "@/lib/format";
import PasswordInput from "@/components/PasswordInput";

interface PoolInfo {
  id: string;
  name: string | null;
  status: string;
  targetCents: number;
  raisedCents: number;
  currency: string;
  quantity: number;
  expiresAt: string;
  eventTitle: string;
  eventSlug: string;
  ticketTypeName: string;
  recipientFirstName: string;
  creatorFirstName: string;
}

// HaloPesa/T-Pesa aren't available on Airpay Tanzania yet (see
// mapNetworkToBankcode in src/lib/payments/airpay.ts) — same list as the
// wallet top-up form.
const NETWORKS = [
  { value: "MPESA", label: "M-Pesa" },
  { value: "TIGO", label: "Tigo Pesa / Mixx by Yas" },
  { value: "AIRTEL", label: "Airtel Money" },
];

const STATUS_COPY: Record<string, string> = {
  FUNDED: "This pool just reached its goal — the ticket is being booked.",
  CONVERTED: "This pool is fully funded and the ticket has been booked.",
  EXPIRED: "This pool's deadline passed before it reached its goal. Every contribution has been refunded.",
  CANCELLED: "This pool was cancelled. Every contribution has been refunded.",
};

export default function PoolPage() {
  const { id } = useParams<{ id: string }>();
  const { user, status: sessionStatus } = useAppSession();

  const [pool, setPool] = useState<PoolInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [amountMajor, setAmountMajor] = useState("");
  const [phone, setPhone] = useState("");
  const [network, setNetwork] = useState(NETWORKS[0].value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingContributionId, setPendingContributionId] = useState<string | null>(null);

  async function loadPool() {
    try {
      const res = await fetch(`/api/pools/${id}`);
      const data = await res.json();
      if (!data.ok) {
        setLoadError(data.error ?? "This pool link is invalid.");
        return;
      }
      setPool(data.pool);
    } catch {
      setLoadError("Couldn't load this pool.");
    }
  }

  useEffect(() => {
    loadPool();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Poll a pending contribution (STK push awaiting confirmation) every few
  // seconds, same role as the wallet top-up page's auto-check.
  useEffect(() => {
    if (!pendingContributionId) return;
    const timer = setInterval(async () => {
      const res = await fetch(`/api/pools/contributions/${pendingContributionId}/check-status`, { method: "POST" });
      const data = await res.json();
      if (data.ok && data.contribution.status !== "PENDING") {
        setPendingContributionId(null);
        setBusy(false);
        await loadPool();
      }
    }, 4000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingContributionId]);

  async function signUpThenContinue(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Couldn't create your account.");
        setBusy(false);
        return;
      }
      const signInRes = await signIn("credentials", { redirect: false, email, password });
      if (signInRes?.error) {
        setError("Account created, but sign-in failed — try signing in manually.");
      }
    } catch {
      setError("Couldn't reach the server.");
    }
    setBusy(false);
  }

  async function contribute(e: React.FormEvent) {
    e.preventDefault();
    if (!pool) return;
    setBusy(true);
    setError(null);
    const amountCents = Math.round(parseFloat(amountMajor) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      setError("Enter a valid amount.");
      setBusy(false);
      return;
    }
    try {
      const res = await fetch(`/api/pools/${pool.id}/contribute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountCents, phoneNumber: phone, mobileNetwork: network, clientId: crypto.randomUUID() }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(
          data.reason === "AMOUNT_EXCEEDS_REMAINING"
            ? "That's more than what's left to raise — try a smaller amount."
            : "Couldn't record your contribution. Please try again."
        );
        setBusy(false);
        return;
      }
      if (data.contribution.status === "PENDING") {
        setPendingContributionId(data.contribution.id);
        return; // stays busy while polling
      }
      setAmountMajor("");
      await loadPool();
      setBusy(false);
    } catch {
      setError("Couldn't reach the server.");
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 py-12">
        <div className="card p-6 text-center text-sm">
          <p className="text-danger">{loadError}</p>
          <Link href="/" className="btn-secondary mt-4 inline-flex">Go home</Link>
        </div>
      </div>
    );
  }

  if (!pool || sessionStatus === "loading") return null;

  const remaining = Math.max(0, pool.targetCents - pool.raisedCents);
  const pct = pool.targetCents > 0 ? Math.min(100, Math.round((pool.raisedCents / pool.targetCents) * 100)) : 0;
  const isOpen = pool.status === "OPEN";

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 py-12">
      <h1 className="mb-1 text-2xl font-bold">{pool.name ?? `${pool.creatorFirstName}'s ticket pool`}</h1>
      <p className="mb-6 text-sm text-muted">
        {pool.ticketTypeName} — {pool.eventTitle} — pooling toward {pool.recipientFirstName}
      </p>

      <div className="card mb-6 space-y-3 p-5">
        <div className="h-2 overflow-hidden rounded-full bg-surface2">
          <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-sm">
          <span className="font-semibold">{formatCents(pool.raisedCents, pool.currency)}</span>
          <span className="text-muted"> of {formatCents(pool.targetCents, pool.currency)} raised</span>
        </p>
        {!isOpen && <p className="text-sm text-muted">{STATUS_COPY[pool.status]}</p>}
      </div>

      {isOpen &&
        (user ? (
          <form onSubmit={contribute} className="card space-y-4 p-6">
            <div>
              <label className="label" htmlFor="amount">Amount ({pool.currency})</label>
              <input
                id="amount"
                type="number"
                min={1}
                step="1"
                required
                className="input"
                placeholder={`Up to ${formatCents(remaining, pool.currency)}`}
                value={amountMajor}
                onChange={(e) => setAmountMajor(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="phone">Phone number</label>
              <input id="phone" required className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="network">Network</label>
              <select id="network" className="input" value={network} onChange={(e) => setNetwork(e.target.value)}>
                {NETWORKS.map((n) => (
                  <option key={n.value} value={n.value}>{n.label}</option>
                ))}
              </select>
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
            <button type="submit" disabled={busy} className="btn-primary w-full disabled:opacity-50">
              {busy ? (pendingContributionId ? "Confirming…" : "Sending…") : "Contribute"}
            </button>
          </form>
        ) : (
          <form onSubmit={signUpThenContinue} className="card space-y-4 p-6">
            <p className="text-sm text-muted">Create an account to contribute to this pool.</p>
            <div>
              <label className="label" htmlFor="name">Full name</label>
              <input id="name" required className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="email">Email</label>
              <input id="email" type="email" required className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="password">Password</label>
              <PasswordInput id="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
            <button type="submit" disabled={busy} className="btn-primary w-full disabled:opacity-50">
              {busy ? "Creating account…" : "Create account & continue"}
            </button>
            <p className="text-center text-xs text-muted">
              Already have an account?{" "}
              <Link href={`/login?callbackUrl=/pools/${pool.id}`} className="font-medium text-accent-hover">Sign in</Link>
            </p>
          </form>
        ))}
    </div>
  );
}
