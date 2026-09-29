"use client";

import { useState } from "react";
import { formatCents } from "@/lib/format";

// HaloPesa/T-Pesa aren't available on Airpay Tanzania yet — confirmed by
// Airpay support — so neither is offered here (see mapNetworkToBankcode in
// src/lib/payments/airpay.ts).
const NETWORKS = [
  { value: "MPESA", label: "M-Pesa" },
  { value: "TIGO", label: "Tigo Pesa" },
  { value: "AIRTEL", label: "Airtel Money" },
];

export default function RenewalActions({ token, price, currency }: { token: string; price: number; currency: string }) {
  const [network, setNetwork] = useState("MPESA");
  const [phone, setPhone] = useState("");
  const [showPhone, setShowPhone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<"CONFIRMED" | "DECLINED" | null>(null);

  async function onRenew(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/renew/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "renew", phoneNumber: phone, mobileNetwork: network }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        setError(body?.error ?? "Couldn't start the payment.");
        return;
      }
      if (body.status === "CONFIRMED") {
        setResult("CONFIRMED");
        return;
      }
      setMessage(body.message ?? "Approve the payment on your phone, then refresh this page.");
    } finally {
      setBusy(false);
    }
  }

  async function onDecline() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/renew/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "decline" }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        setError(body?.error ?? "Something went wrong.");
        return;
      }
      setResult("DECLINED");
    } finally {
      setBusy(false);
    }
  }

  if (result === "CONFIRMED") {
    return (
      <div className="card p-5 text-center">
        <p className="text-lg font-semibold">✅ Your season pass has been renewed!</p>
        <p className="mt-1 text-sm text-muted">Your wristband stays active. See you at the next match.</p>
      </div>
    );
  }
  if (result === "DECLINED") {
    return (
      <div className="card p-5 text-center">
        <p className="font-semibold">Understood — your pass won&apos;t auto-renew.</p>
        <p className="mt-1 text-sm text-muted">You can always renew manually at chaap.africa.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}
      {message && <div className="rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-sm text-accent-hover">{message}</div>}

      {!showPhone ? (
        <button className="btn-primary w-full !h-14 !text-lg" onClick={() => setShowPhone(true)}>
          Renew for {formatCents(price, currency)}
        </button>
      ) : (
        <form onSubmit={onRenew} className="space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor="renew-network">Mobile network</label>
            <select id="renew-network" className="input" value={network} onChange={(e) => setNetwork(e.target.value)}>
              {NETWORKS.map((n) => (
                <option key={n.value} value={n.value}>{n.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor="renew-phone">Mobile money number</label>
            <input
              id="renew-phone"
              className="input"
              placeholder="07XX XXX XXX"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              autoFocus
            />
          </div>
          <button type="submit" className="btn-primary w-full !h-14 !text-lg" disabled={busy || !phone.trim()}>
            {busy ? "Confirming…" : `Confirm ${formatCents(price, currency)}`}
          </button>
        </form>
      )}

      <button className="btn-secondary w-full" disabled={busy} onClick={onDecline}>
        No thanks
      </button>
    </div>
  );
}
