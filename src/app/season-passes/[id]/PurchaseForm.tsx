"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatCents } from "@/lib/format";

const NETWORKS = [
  { value: "MPESA", label: "M-Pesa" },
  { value: "TIGO", label: "Tigo Pesa" },
  { value: "AIRTEL", label: "Airtel Money" },
  { value: "HALOTEL", label: "HaloPesa" },
];

export default function PurchaseForm({
  seasonPassId,
  price,
  currency,
  purchasable,
  signedIn,
}: {
  seasonPassId: string;
  price: number;
  currency: string;
  purchasable: boolean;
  signedIn: boolean;
}) {
  const router = useRouter();
  const [network, setNetwork] = useState("MPESA");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  async function onBuy(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/season-passes/${seasonPassId}/purchase`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: phone, mobileNetwork: network }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        setError(body?.error ?? "Couldn't start the payment.");
        return;
      }
      if (body.status === "CONFIRMED") {
        setConfirmed(true);
        return;
      }
      setMessage(body.message ?? "Approve the payment on your phone, then refresh this page.");
    } finally {
      setBusy(false);
    }
  }

  if (!purchasable) {
    return <div className="card p-5 text-center text-muted">This season pass isn't available for purchase right now.</div>;
  }

  if (confirmed) {
    return (
      <div className="card p-5 text-center">
        <p className="text-lg font-semibold">🎟 You're in!</p>
        <p className="mt-1 text-sm text-muted">Check WhatsApp for your confirmation. Your wristband will be activated at your first match.</p>
        <button className="btn-secondary mt-4" onClick={() => router.refresh()}>Done</button>
      </div>
    );
  }

  if (!signedIn) {
    return (
      <Link href={`/login?callbackUrl=/season-passes/${seasonPassId}`} className="btn-primary w-full !flex justify-center">
        Sign in to buy
      </Link>
    );
  }

  return (
    <form onSubmit={onBuy} className="card space-y-3 p-5">
      {error && <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}
      {message && <div className="rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-sm text-accent-hover">{message}</div>}

      <div>
        <label className="mb-1 block text-sm font-medium" htmlFor="sp-network">Mobile network</label>
        <select id="sp-network" className="input" value={network} onChange={(e) => setNetwork(e.target.value)}>
          {NETWORKS.map((n) => (
            <option key={n.value} value={n.value}>{n.label}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="mb-1 block text-sm font-medium" htmlFor="sp-phone">Mobile money number</label>
        <input
          id="sp-phone"
          className="input"
          placeholder="07XX XXX XXX"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
      </div>
      <button type="submit" className="btn-primary w-full" disabled={busy || !phone.trim()}>
        {busy ? "Processing…" : `Pay ${formatCents(price, currency)}`}
      </button>
    </form>
  );
}
