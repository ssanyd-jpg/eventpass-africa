"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents } from "@/lib/format";
import { publishSeasonPassAction, setAutoRenewAction, sendRenewalOffersNowAction } from "./actions";
import type { SeasonPassListRow } from "@/lib/season-pass";

export default function SeasonPassRow({ seasonPass: p }: { seasonPass: SeasonPassListRow }) {
  const router = useRouter();
  const [autoRenewEnabled, setAutoRenewEnabled] = useState(p.autoRenewEnabled);
  const [renewalPrice, setRenewalPrice] = useState(String(((p.autoRenewPrice ?? p.price) / 100).toFixed(2)));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onPublish() {
    setBusy(true);
    setError(null);
    try {
      const result = await publishSeasonPassAction(p.id);
      if (!result.ok) setError(result.error);
      else router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function onSaveRenewal(nextEnabled: boolean) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const cents = Math.round(Number(renewalPrice) * 100);
      const result = await setAutoRenewAction(p.id, nextEnabled, Number.isFinite(cents) && cents > 0 ? cents : null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAutoRenewEnabled(nextEnabled);
      setNotice("Renewal settings saved.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function onSendOffersNow() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await sendRenewalOffersNowAction(p.id);
      setNotice(
        result.sent > 0
          ? `Sent ${result.sent} renewal offer${result.sent === 1 ? "" : "s"}.`
          : "No holders are currently eligible for a renewal offer."
      );
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 space-y-3 border-t border-dashed border-border pt-4">
      {p.status === "DRAFT" && (
        <button className="btn-primary" disabled={busy} onClick={onPublish}>
          Publish (start selling)
        </button>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={autoRenewEnabled}
            disabled={busy}
            onChange={(e) => onSaveRenewal(e.target.checked)}
          />
          Auto-renew
        </label>
        <div>
          <label className="label" htmlFor={`renewal-price-${p.id}`}>Renewal price (TZS)</label>
          <input
            id={`renewal-price-${p.id}`}
            type="number"
            min={0.01}
            step="0.01"
            className="input !w-40"
            value={renewalPrice}
            onChange={(e) => setRenewalPrice(e.target.value)}
            onBlur={() => onSaveRenewal(autoRenewEnabled)}
          />
        </div>
        <button className="btn-secondary" disabled={busy} onClick={onSendOffersNow}>
          Send renewal offers now
        </button>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}
      {notice && <p className="text-sm text-ok">{notice}</p>}
      <p className="text-xs text-muted">
        Original price {formatCents(p.price, p.currency)} — renewal price pre-fills with it until changed.
      </p>
    </div>
  );
}
