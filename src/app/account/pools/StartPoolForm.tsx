"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { startPool } from "./actions";
import { formatCents } from "@/lib/format";

interface Props {
  ticketTypeId: string;
  ticketTypeName: string;
  priceCents: number;
  currency: string;
  eventTitle: string;
}

export default function StartPoolForm({ ticketTypeId, ticketTypeName, priceCents, currency, eventTitle }: Props) {
  const [quantity, setQuantity] = useState(1);
  const [name, setName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState(14);
  const [error, setError] = useState<string | null>(null);
  const [createdPoolId, setCreatedPoolId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const result = await startPool({ ticketTypeId, quantity, name: name.trim() || undefined, expiresInDays });
        setCreatedPoolId(result.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't start the pool. Please try again.");
      }
    });
  }

  if (createdPoolId) {
    return (
      <div className="card space-y-3 p-5">
        <p className="text-sm text-ok">Pool created — share this link so people can contribute:</p>
        <Link href={`/pools/${createdPoolId}`} className="block truncate text-sm font-medium text-accent-hover">
          chaap.africa/pools/{createdPoolId}
        </Link>
        <Link href="/account/pools" className="btn-secondary inline-flex">
          Done
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="card space-y-4 p-5">
      <div>
        <h2 className="mb-1 text-lg font-semibold">Start a group pool</h2>
        <p className="text-sm text-muted">
          {ticketTypeName} — {eventTitle} — {formatCents(priceCents, currency)} each
        </p>
      </div>
      <div>
        <label className="label" htmlFor="pool-name">Pool name (optional)</label>
        <input
          id="pool-name"
          className="input"
          placeholder="e.g. Asha's birthday pool"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="pool-quantity">Tickets</label>
          <input
            id="pool-quantity"
            type="number"
            min={1}
            max={20}
            className="input"
            value={quantity}
            onChange={(e) => setQuantity(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
          />
        </div>
        <div>
          <label className="label" htmlFor="pool-expiry">Days to raise it</label>
          <input
            id="pool-expiry"
            type="number"
            min={1}
            max={90}
            className="input"
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(Math.max(1, Math.min(90, Number(e.target.value) || 14)))}
          />
        </div>
      </div>
      <p className="text-sm text-muted">
        Target: {formatCents(priceCents * quantity, currency)}
      </p>
      {error && <p className="text-sm text-danger">{error}</p>}
      <button type="submit" disabled={isPending} className="btn-primary disabled:opacity-50">
        {isPending ? "Starting…" : "Start pool"}
      </button>
    </form>
  );
}
