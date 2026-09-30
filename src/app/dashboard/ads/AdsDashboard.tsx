"use client";

import { useState } from "react";
import FeaturedListingsTab from "./FeaturedListingsTab";
import BroadcastTab from "./BroadcastTab";
import type { FeaturedListingHistoryRow, BroadcastHistoryRow, FeaturedTier } from "@/lib/chaap-ads";

interface AdsDashboardProps {
  events: { id: string; title: string }[];
  slotAvailability: Record<FeaturedTier, number>;
  pricing: Record<FeaturedTier, { amountCents: number; days: number }>;
  listingHistory: FeaturedListingHistoryRow[];
  broadcastHistory: BroadcastHistoryRow[];
  broadcastPricing: { perRecipientCents: number; minAmountCents: number; messageMaxLength: number };
}

export default function AdsDashboard({
  events,
  slotAvailability,
  pricing,
  listingHistory,
  broadcastHistory,
  broadcastPricing,
}: AdsDashboardProps) {
  const [tab, setTab] = useState<"featured" | "broadcast">("featured");

  return (
    <div className="mt-6">
      <div className="mb-6 flex gap-2 border-b border-border">
        {(
          [
            ["featured", "Featured listings"],
            ["broadcast", "Broadcast"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition ${
              tab === key ? "border-accent text-accent-hover" : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "featured" ? (
        <FeaturedListingsTab events={events} slotAvailability={slotAvailability} pricing={pricing} history={listingHistory} />
      ) : (
        <BroadcastTab history={broadcastHistory} pricing={broadcastPricing} />
      )}
    </div>
  );
}
