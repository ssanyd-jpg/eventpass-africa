"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatCents, formatDateTime } from "@/lib/format";
import { RESALE_COMMISSION_RATE, calculateCommission } from "@/lib/resale-pricing";
import type { TicketResaleState } from "@/lib/resale";

export default function ResaleControl({ ticket }: { ticket: TicketResaleState }) {
  const router = useRouter();
  const { listing } = ticket;
  // Major units in the input (cents/100), pre-filled with face value — or the
  // organiser's lower cap when there is one, so the default is always valid.
  const [price, setPrice] = useState(String(ticket.maxPrice / 100));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const priceCents = Math.round(Number(price) * 100);
  const priceValid = Number.isFinite(priceCents) && priceCents > 0 && priceCents <= ticket.maxPrice;
  const payout = priceValid ? calculateCommission(priceCents).sellerPayoutAmount : null;

  async function onList() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tickets/${ticket.ticketId}/resale`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ askingPrice: priceCents }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        setError(body?.error ?? "Couldn't list the ticket.");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function onCancel() {
    if (!listing) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/resale/listings/${listing.id}`, { method: "DELETE" });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        setError(body?.error ?? "Couldn't cancel the listing.");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (listing) {
    return (
      <div className="card space-y-3 p-5">
        <p>
          Listed at <strong>{formatCents(listing.askingPrice, ticket.currency)}</strong>
          {listing.expiresAt && <span className="text-muted"> until {formatDateTime(listing.expiresAt)}</span>}.
        </p>
        <p className="text-sm text-muted">
          When it sells you&apos;ll receive {formatCents(listing.sellerPayoutAmount, ticket.currency)} after
          Chaap&apos;s {RESALE_COMMISSION_RATE * 100}% commission.
        </p>
        {listing.buyerPaying && (
          <p className="text-sm text-warn">A buyer is completing payment right now, so this can&apos;t be cancelled for a few minutes.</p>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex flex-wrap gap-3">
          <button className="btn-secondary" disabled={busy || listing.buyerPaying} onClick={onCancel}>
            {busy ? "Cancelling…" : "Cancel listing"}
          </button>
          <Link href={`/events/${ticket.eventSlug}/resale`} className="btn-secondary">View marketplace</Link>
        </div>
      </div>
    );
  }

  if (ticket.cannotListReason) {
    return <div className="card p-5 text-sm text-muted">{ticket.cannotListReason}</div>;
  }

  return (
    <div className="card space-y-4 p-5">
      <div>
        <label className="mb-1 block text-sm font-medium" htmlFor="asking-price">Asking price ({ticket.currency})</label>
        <input
          id="asking-price"
          type="number"
          min={0}
          max={ticket.maxPrice / 100}
          step="any"
          className="input max-w-xs"
          value={price}
          disabled={busy}
          onChange={(e) => setPrice(e.target.value)}
        />
        <p className="mt-1 text-xs text-muted">
          Face value {formatCents(ticket.originalPrice, ticket.currency)}.
          {ticket.maxPrice < ticket.originalPrice
            ? ` The organiser caps resale at ${formatCents(ticket.maxPrice, ticket.currency)}.`
            : " You can list at face value or below — never above."}
        </p>
      </div>
      {!priceValid && price !== "" && (
        <p className="text-sm text-danger">Enter a price up to {formatCents(ticket.maxPrice, ticket.currency)}.</p>
      )}
      {payout !== null && (
        <p className="text-sm text-muted">
          You&apos;ll receive {formatCents(payout, ticket.currency)} after Chaap&apos;s {RESALE_COMMISSION_RATE * 100}% commission.
          The listing stays up for 7 days, or until the event starts.
        </p>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
      <button className="btn-primary" disabled={busy || !priceValid} onClick={onList}>
        {busy ? "Listing…" : "List for resale"}
      </button>
    </div>
  );
}
