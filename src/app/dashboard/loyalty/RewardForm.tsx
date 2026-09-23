"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createRewardAction } from "./actions";
import type { RewardType } from "@/lib/loyalty-rewards-pricing";

const REWARD_TYPE_OPTIONS: { value: RewardType; label: string }[] = [
  { value: "DISCOUNT_CODE", label: "Discount code" },
  { value: "FREE_TICKET", label: "Free ticket" },
  { value: "WALLET_CREDIT", label: "Wallet credit" },
  { value: "CUSTOM", label: "Custom (shown at a stand, etc.)" },
];

const TIER_OPTIONS = [
  { value: "NEW", label: "NEW and above (everyone)" },
  { value: "REPEAT", label: "REPEAT and above" },
  { value: "VIP", label: "VIP only" },
] as const;

interface EventOption {
  id: string;
  title: string;
  ticketTypes: { id: string; name: string }[];
}

export default function RewardForm({ events }: { events: EventOption[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rewardType, setRewardType] = useState<RewardType>("DISCOUNT_CODE");
  const [value, setValue] = useState("");
  const [requiredTier, setRequiredTier] = useState<"NEW" | "REPEAT" | "VIP">("NEW");
  const [stock, setStock] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [eventId, setEventId] = useState("");
  const [ticketTypeId, setTicketTypeId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const needsTicketType = rewardType === "DISCOUNT_CODE" || rewardType === "FREE_TICKET";
  const needsValue = rewardType === "DISCOUNT_CODE" || rewardType === "WALLET_CREDIT";
  const selectedEvent = events.find((e) => e.id === eventId);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const valueCents =
        rewardType === "DISCOUNT_CODE" ? Math.round(Number(value))
        : rewardType === "WALLET_CREDIT" ? Math.round(Number(value) * 100)
        : 0;

      const result = await createRewardAction({
        name,
        description,
        rewardType,
        value: valueCents,
        requiredTier,
        stock: stock.trim() === "" ? null : Math.round(Number(stock)),
        expiresAt: expiresAt.trim() === "" ? null : new Date(expiresAt),
        eventId: needsTicketType ? eventId || null : null,
        ticketTypeId: needsTicketType ? ticketTypeId || null : null,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(`"${name}" created.`);
      setName("");
      setDescription("");
      setValue("");
      setStock("");
      setExpiresAt("");
      setEventId("");
      setTicketTypeId("");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-4 p-5">
      <h2 className="font-semibold">Create a reward</h2>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="reward-name">Name</label>
          <input
            id="reward-name"
            required
            className="input"
            placeholder="Free drink voucher"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="reward-type">Type</label>
          <select
            id="reward-type"
            className="input"
            value={rewardType}
            onChange={(e) => setRewardType(e.target.value as RewardType)}
          >
            {REWARD_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="label" htmlFor="reward-description">
          {rewardType === "CUSTOM" ? "Instructions (sent to the attendee by WhatsApp)" : "Description"}
        </label>
        <input
          id="reward-description"
          required={rewardType === "CUSTOM"}
          className="input"
          placeholder={rewardType === "CUSTOM" ? "Show this message at the merchandise stand" : "What the attendee gets"}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {needsValue && (
          <div>
            <label className="label" htmlFor="reward-value">
              {rewardType === "DISCOUNT_CODE" ? "Discount (%)" : "Credit amount (TZS)"}
            </label>
            <input
              id="reward-value"
              type="number"
              min={rewardType === "DISCOUNT_CODE" ? 1 : 1}
              max={rewardType === "DISCOUNT_CODE" ? 100 : undefined}
              required
              className="input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
        )}
        <div>
          <label className="label" htmlFor="reward-tier">Required tier</label>
          <select
            id="reward-tier"
            className="input"
            value={requiredTier}
            onChange={(e) => setRequiredTier(e.target.value as "NEW" | "REPEAT" | "VIP")}
          >
            {TIER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="reward-stock">Stock limit</label>
          <input
            id="reward-stock"
            type="number"
            min={1}
            className="input"
            placeholder="Unlimited"
            value={stock}
            onChange={(e) => setStock(e.target.value)}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="reward-expires">Expires</label>
          <input
            id="reward-expires"
            type="date"
            className="input"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </div>
        {needsTicketType && (
          <>
            <div>
              <label className="label" htmlFor="reward-event">Event</label>
              <select
                id="reward-event"
                required
                className="input"
                value={eventId}
                onChange={(e) => {
                  setEventId(e.target.value);
                  setTicketTypeId("");
                }}
              >
                <option value="">Select an event…</option>
                {events.map((ev) => (
                  <option key={ev.id} value={ev.id}>{ev.title}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="reward-ticket-type">Ticket type</label>
              <select
                id="reward-ticket-type"
                required
                className="input"
                value={ticketTypeId}
                disabled={!selectedEvent}
                onChange={(e) => setTicketTypeId(e.target.value)}
              >
                <option value="">Select a ticket type…</option>
                {(selectedEvent?.ticketTypes ?? []).map((tt) => (
                  <option key={tt.id} value={tt.id}>{tt.name}</option>
                ))}
              </select>
            </div>
          </>
        )}
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}
      {notice && <p className="text-sm text-ok">{notice}</p>}
      <button type="submit" disabled={submitting} className="btn-primary">
        {submitting ? "Creating…" : "Create reward"}
      </button>
    </form>
  );
}
