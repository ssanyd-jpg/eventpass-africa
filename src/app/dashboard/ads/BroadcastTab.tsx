"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents, formatDateTime } from "@/lib/format";
import { createBroadcastAction, estimateReachAction, sendScheduledBroadcastAction } from "./actions";
import type { BroadcastHistoryRow } from "@/lib/chaap-ads";

const NETWORKS = [
  { value: "MPESA", label: "M-Pesa" },
  { value: "TIGO", label: "Tigo Pesa" },
  { value: "AIRTEL", label: "Airtel Money" },
];

// Exactly the four segments the product spec calls for — not every
// EventType in event-modes.ts. AdBroadcast/estimateBroadcastReach support
// any subset for later, but v1's UI only exposes these.
const TARGET_OPTIONS: { label: string; eventTypes: string[] }[] = [
  { label: "All attendees", eventTypes: [] },
  { label: "Marathon attendees", eventTypes: ["MARATHON"] },
  { label: "Festival attendees", eventTypes: ["FESTIVAL"] },
  { label: "Football attendees", eventTypes: ["FOOTBALL"] },
];

const STATUS_LABEL: Record<string, string> = { SCHEDULED: "Scheduled", SENT: "Sent", CANCELLED: "Cancelled" };

interface BroadcastTabProps {
  history: BroadcastHistoryRow[];
  pricing: { perRecipientCents: number; minAmountCents: number; messageMaxLength: number };
}

export default function BroadcastTab({ history, pricing }: BroadcastTabProps) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [targetIndex, setTargetIndex] = useState(0);
  const [sendNow, setSendNow] = useState(true);
  const [scheduledAt, setScheduledAt] = useState("");
  const [network, setNetwork] = useState("MPESA");
  const [phone, setPhone] = useState("");
  const [reach, setReach] = useState<number | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);

  const targetEventTypes = TARGET_OPTIONS[targetIndex].eventTypes;

  useEffect(() => {
    let cancelled = false;
    setEstimating(true);
    estimateReachAction(targetEventTypes)
      .then((count) => {
        if (!cancelled) setReach(count);
      })
      .finally(() => {
        if (!cancelled) setEstimating(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetIndex]);

  const amountCents = reach !== null ? Math.max(pricing.minAmountCents, reach * pricing.perRecipientCents) : null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await createBroadcastAction(
        message,
        targetEventTypes,
        sendNow,
        sendNow ? new Date() : new Date(scheduledAt),
        { phoneNumber: phone, mobileNetwork: network }
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.status === "PENDING") {
        setNotice(result.message ?? "Approve the payment on your phone, then refresh this page.");
        return;
      }
      setNotice(
        result.sentNow
          ? `Sent to ${result.recipientCount} attendee${result.recipientCount === 1 ? "" : "s"}.`
          : "Broadcast scheduled — it'll wait in history until you send it."
      );
      setMessage("");
      setPhone("");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function onSendNow(broadcastId: string) {
    setSendingId(broadcastId);
    try {
      await sendScheduledBroadcastAction(broadcastId);
      router.refresh();
    } finally {
      setSendingId(null);
    }
  }

  return (
    <div>
      <form onSubmit={onSubmit} className="card space-y-4 p-5">
        <h2 className="font-semibold">Write a broadcast</h2>

        <div>
          <label className="label" htmlFor="ads-message">Message</label>
          <textarea
            id="ads-message"
            required
            className="input min-h-24"
            maxLength={pricing.messageMaxLength}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="20% off early-bird tickets for our next marathon — book now on Chaap!"
          />
          <p className="mt-1 text-right text-xs text-muted">{message.length}/{pricing.messageMaxLength}</p>
        </div>

        <div>
          <label className="label" htmlFor="ads-target">Target</label>
          <select
            id="ads-target"
            className="input"
            value={targetIndex}
            onChange={(e) => setTargetIndex(Number(e.target.value))}
          >
            {TARGET_OPTIONS.map((opt, i) => (
              <option key={opt.label} value={i}>{opt.label}</option>
            ))}
          </select>
          <p className="mt-1 text-sm text-muted">
            {estimating ? "Estimating reach…" : reach !== null ? `~${reach.toLocaleString()} people will receive this` : null}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" checked={sendNow} onChange={() => setSendNow(true)} />
            Send now
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" checked={!sendNow} onChange={() => setSendNow(false)} />
            Schedule for later
          </label>
          {!sendNow && (
            <input
              type="datetime-local"
              required={!sendNow}
              className="input w-auto"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
            />
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="ads-broadcast-network">Mobile network</label>
            <select id="ads-broadcast-network" className="input" value={network} onChange={(e) => setNetwork(e.target.value)}>
              {NETWORKS.map((n) => (
                <option key={n.value} value={n.value}>{n.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="ads-broadcast-phone">Mobile money number</label>
            <input
              id="ads-broadcast-phone"
              className="input"
              placeholder="07XX XXX XXX"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}
        {notice && <p className="text-sm text-ok">{notice}</p>}

        <button
          type="submit"
          disabled={busy || !message.trim() || !phone.trim() || (!sendNow && !scheduledAt) || !amountCents}
          className="btn-primary"
        >
          {busy ? "Processing…" : amountCents ? `Pay ${formatCents(amountCents)}` : "Pay"}
        </button>
      </form>

      <h2 className="mb-3 mt-8 font-semibold">Broadcast history</h2>
      {history.length === 0 ? (
        <div className="card p-8 text-center text-muted">No broadcasts yet — write one above.</div>
      ) : (
        <div className="card divide-y divide-border">
          {history.map((b) => (
            <div key={b.id} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
              <div>
                <p className="font-medium">
                  {b.message}
                  <span className="ml-2 pill border-border text-muted">{STATUS_LABEL[b.status] ?? b.status}</span>
                </p>
                <p className="mt-1 text-xs text-muted">
                  {b.targetEventTypes.length === 0 ? "All attendees" : b.targetEventTypes.join(", ")} ·{" "}
                  {formatCents(b.amountPaidCents, b.currency)}
                  {b.sentAt ? ` · sent ${formatDateTime(b.sentAt)} to ${b.recipientCount}` : ` · scheduled ${formatDateTime(b.scheduledAt)}`}
                </p>
              </div>
              {b.status === "SCHEDULED" && !b.sentAt && (
                <button
                  type="button"
                  onClick={() => onSendNow(b.id)}
                  disabled={sendingId === b.id}
                  className="btn-secondary !px-3 !py-1.5 text-xs"
                >
                  {sendingId === b.id ? "Sending…" : "Send now"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
