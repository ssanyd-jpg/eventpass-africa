"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatCents, formatDateTime } from "@/lib/format";
import type { PublicListing } from "@/lib/resale";

const NETWORKS = [
  { value: "MPESA", label: "M-Pesa" },
  { value: "TIGO", label: "Tigo Pesa" },
  { value: "AIRTEL", label: "Airtel Money" },
  { value: "HALOTEL", label: "HaloPesa" },
];

const POLL_INTERVAL_MS = 3000;
const POLL_ATTEMPTS = 60; // ~3 minutes, well inside the 10-minute reservation

export default function ResaleListings({
  slug,
  listings,
  signedIn,
}: {
  slug: string;
  listings: PublicListing[];
  signedIn: boolean;
}) {
  const router = useRouter();
  const [buyingId, setBuyingId] = useState<string | null>(null);
  const [network, setNetwork] = useState("MPESA");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  function finish(ticketId: string) {
    router.push(`/account/tickets/${ticketId}`);
  }

  async function pollUntilResolved(listingId: string) {
    for (let i = 0; i < POLL_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (cancelled.current) return;
      const res = await fetch(`/api/events/${slug}/resale/${listingId}/check`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        setError(body?.error ?? "Couldn't confirm the payment.");
        return;
      }
      if (body.status === "SOLD") return finish(body.ticketId);
      if (body.status === "FAILED") {
        setError(body.error ?? "The payment wasn't confirmed.");
        return;
      }
    }
    setMessage("Still waiting for your confirmation. If you approved the payment, refresh this page in a minute.");
  }

  async function onBuy(listingId: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/events/${slug}/resale/${listingId}/buy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: phone, mobileNetwork: network }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        setError(body?.error ?? "Couldn't start the payment.");
        return;
      }
      if (body.status === "SOLD") return finish(body.ticketId);
      setMessage(body.message ?? "Approve the payment on your phone…");
      await pollUntilResolved(listingId);
    } finally {
      setBusy(false);
    }
  }

  if (listings.length === 0) {
    return <div className="card p-10 text-center text-muted">No resale tickets are listed right now. Check back soon.</div>;
  }

  return (
    <div className="space-y-3">
      {error && <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}
      {message && <div className="rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-sm text-accent-hover">{message}</div>}

      {listings.map((l) => (
        <div key={l.id} className="card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-semibold">{l.ticketTypeName}</p>
              <p className="text-sm text-muted">
                Face value <span className="line-through">{formatCents(l.originalPrice, l.currency)}</span>
                {l.savings > 0 && <span className="ml-2 text-ok">Save {formatCents(l.savings, l.currency)}</span>}
              </p>
              {l.expiresAt && <p className="text-xs text-muted">Listed until {formatDateTime(l.expiresAt)}</p>}
            </div>
            <div className="flex items-center gap-4">
              <p className="text-xl font-bold">{formatCents(l.askingPrice, l.currency)}</p>
              {l.isOwn ? (
                <span className="pill">Your listing</span>
              ) : !signedIn ? (
                <Link href={`/login?callbackUrl=/events/${slug}/resale`} className="btn-primary">
                  Sign in to buy
                </Link>
              ) : (
                <button className="btn-primary" disabled={busy} onClick={() => setBuyingId(buyingId === l.id ? null : l.id)}>
                  Buy this ticket
                </button>
              )}
            </div>
          </div>

          {buyingId === l.id && !l.isOwn && (
            <div className="mt-4 space-y-3 border-t border-dashed border-border pt-4">
              <div>
                <label className="mb-1 block text-sm font-medium" htmlFor={`network-${l.id}`}>Mobile network</label>
                <select id={`network-${l.id}`} className="input" value={network} onChange={(e) => setNetwork(e.target.value)}>
                  {NETWORKS.map((n) => (
                    <option key={n.value} value={n.value}>{n.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium" htmlFor={`phone-${l.id}`}>Mobile money number</label>
                <input
                  id={`phone-${l.id}`}
                  className="input"
                  placeholder="07XX XXX XXX"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>
              <button className="btn-primary w-full" disabled={busy || !phone.trim()} onClick={() => onBuy(l.id)}>
                {busy ? "Waiting for payment…" : `Pay ${formatCents(l.askingPrice, l.currency)}`}
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
