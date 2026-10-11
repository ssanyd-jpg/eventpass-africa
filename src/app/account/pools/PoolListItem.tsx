"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { cancelPool } from "./actions";
import { formatCents } from "@/lib/format";

const STATUS_LABEL: Record<string, string> = {
  OPEN: "Open",
  FUNDED: "Funded",
  CONVERTED: "Booked",
  EXPIRED: "Expired",
  CANCELLED: "Cancelled",
};

interface Props {
  pool: {
    id: string;
    name: string | null;
    status: string;
    targetCents: number;
    raisedCents: number;
    currency: string;
    eventTitle: string;
    ticketTypeName: string;
  };
  canCancel: boolean;
}

export default function PoolListItem({ pool, canCancel }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [cancelled, setCancelled] = useState(false);

  function handleCancel() {
    setError(null);
    startTransition(async () => {
      try {
        await cancelPool(pool.id);
        setCancelled(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't cancel this pool.");
      }
    });
  }

  const status = cancelled ? "CANCELLED" : pool.status;
  const pct = pool.targetCents > 0 ? Math.min(100, Math.round((pool.raisedCents / pool.targetCents) * 100)) : 0;

  return (
    <div className="card space-y-2 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium">{pool.name ?? pool.ticketTypeName}</p>
          <p className="text-xs text-muted">{pool.ticketTypeName} — {pool.eventTitle}</p>
        </div>
        <span className="pill !py-0.5 text-[10px]">{STATUS_LABEL[status] ?? status}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface2">
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-sm text-muted">
        {formatCents(pool.raisedCents, pool.currency)} of {formatCents(pool.targetCents, pool.currency)} raised
      </p>
      <div className="flex items-center gap-3">
        <Link href={`/pools/${pool.id}`} className="text-xs font-medium text-accent-hover">
          View / share link
        </Link>
        {canCancel && status === "OPEN" && (
          <button type="button" disabled={isPending} onClick={handleCancel} className="text-xs font-medium text-danger disabled:opacity-50">
            {isPending ? "Cancelling…" : "Cancel pool"}
          </button>
        )}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
