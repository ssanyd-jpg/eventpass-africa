"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents, formatDate } from "@/lib/format";
import { promoteEventAction } from "./actions";
import type { FeaturedListingHistoryRow, FeaturedTier } from "@/lib/chaap-ads";

// HaloPesa/T-Pesa aren't available on Airpay Tanzania yet — same list as
// PurchaseForm.tsx/RenewalActions.tsx (see mapNetworkToBankcode in
// src/lib/payments/airpay.ts).
const NETWORKS = [
  { value: "MPESA", label: "M-Pesa" },
  { value: "TIGO", label: "Tigo Pesa" },
  { value: "AIRTEL", label: "Airtel Money" },
];

const STATUS_LABEL: Record<string, string> = { ACTIVE: "Active", EXPIRED: "Expired", CANCELLED: "Cancelled" };

interface FeaturedListingsTabProps {
  events: { id: string; title: string }[];
  slotAvailability: Record<FeaturedTier, number>;
  pricing: Record<FeaturedTier, { amountCents: number; days: number }>;
  history: FeaturedListingHistoryRow[];
}

export default function FeaturedListingsTab({ events, slotAvailability, pricing, history }: FeaturedListingsTabProps) {
  const router = useRouter();
  const [eventId, setEventId] = useState("");
  const [tier, setTier] = useState<FeaturedTier>("FEATURED");
  const [network, setNetwork] = useState("MPESA");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedEvent = events.find((e) => e.id === eventId);
  const currentPricing = pricing[tier];

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedEvent) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await promoteEventAction(eventId, tier, selectedEvent.title, { phoneNumber: phone, mobileNetwork: network });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.status === "PENDING") {
        setNotice(result.message ?? "Approve the payment on your phone, then refresh this page.");
        return;
      }
      setNotice(`"${selectedEvent.title}" is now ${tier === "SPOTLIGHT" ? "in the Spotlight" : "Featured"}.`);
      setEventId("");
      setPhone("");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <form onSubmit={onSubmit} className="card space-y-4 p-5">
        <h2 className="font-semibold">Promote this event</h2>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="ads-event">Event</label>
            <select id="ads-event" required className="input" value={eventId} onChange={(e) => setEventId(e.target.value)}>
              <option value="">Select an event…</option>
              {events.map((ev) => (
                <option key={ev.id} value={ev.id}>{ev.title}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="ads-tier">Tier</label>
            <select id="ads-tier" className="input" value={tier} onChange={(e) => setTier(e.target.value as FeaturedTier)}>
              <option value="FEATURED" disabled={slotAvailability.FEATURED <= 0}>
                Featured — {formatCents(pricing.FEATURED.amountCents)} / {pricing.FEATURED.days} days
                {slotAvailability.FEATURED <= 0 ? " (full)" : ` (${slotAvailability.FEATURED} slot${slotAvailability.FEATURED === 1 ? "" : "s"} left)`}
              </option>
              <option value="SPOTLIGHT" disabled={slotAvailability.SPOTLIGHT <= 0}>
                Spotlight — {formatCents(pricing.SPOTLIGHT.amountCents)} / {pricing.SPOTLIGHT.days} days
                {slotAvailability.SPOTLIGHT <= 0 ? " (full)" : ` (${slotAvailability.SPOTLIGHT} slot left)`}
              </option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="ads-network">Mobile network</label>
            <select id="ads-network" className="input" value={network} onChange={(e) => setNetwork(e.target.value)}>
              {NETWORKS.map((n) => (
                <option key={n.value} value={n.value}>{n.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="ads-phone">Mobile money number</label>
            <input
              id="ads-phone"
              className="input"
              placeholder="07XX XXX XXX"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}
        {notice && <p className="text-sm text-ok">{notice}</p>}

        <button type="submit" disabled={busy || !eventId || !phone.trim() || slotAvailability[tier] <= 0} className="btn-primary">
          {busy ? "Processing…" : `Pay ${formatCents(currentPricing.amountCents)}`}
        </button>
      </form>

      <h2 className="mb-3 mt-8 font-semibold">Listing history</h2>
      {history.length === 0 ? (
        <div className="card p-8 text-center text-muted">No listings yet — promote an event above.</div>
      ) : (
        <div className="card divide-y divide-border">
          {history.map((h) => (
            <div key={h.id} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
              <div>
                <p className="font-medium">
                  {h.eventTitle}
                  <span className="ml-2 pill border-border text-muted">{h.tier}</span>
                  <span className="ml-2 pill border-border text-muted">{STATUS_LABEL[h.status] ?? h.status}</span>
                </p>
                <p className="mt-1 text-xs text-muted">
                  {formatDate(h.startDate)} – {formatDate(h.endDate)} · {formatCents(h.amountPaidCents, h.currency)}
                </p>
              </div>
              <p className="text-xs text-muted">{h.eventViewCount} page view{h.eventViewCount === 1 ? "" : "s"}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
