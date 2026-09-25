"use client";

import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db";
import EventCard from "@/components/EventCard";
import { useOnlineStatus } from "@/lib/sync-engine";
import { useTranslation } from "@/lib/use-translation";

const CATEGORIES = ["All", "Music", "Sports", "Comedy", "Conference", "Festival"];

// Everything the old (fully client, Dexie-backed) HomePage used to render
// below its hero — unchanged logic, just extracted so the new Server
// Component homepage (src/app/page.tsx) can put its server-rendered
// marketing sections (hero/featured/how-it-works/stats) above it. This
// section stays client-side and IndexedDB-backed on purpose: it reflects
// events already synced to *this* buyer's device (recommendations, anything
// bought or bookmarked offline), which the new public /events marketplace
// page (a live, server-rendered Prisma query across every organisation)
// doesn't and shouldn't replace.
export default function HomeBrowse() {
  const [category, setCategory] = useState("All");
  const [query, setQuery] = useState("");
  const [vendorsOnly, setVendorsOnly] = useState(false);
  const online = useOnlineStatus();
  const { t } = useTranslation();

  const events = useLiveQuery(() => db.events.orderBy("startsAt").toArray(), [], undefined);

  // Deterministic same-category recommendations (see recommendations.ts) —
  // only ids ride over the wire, so look each one up against the
  // already-synced events table. Empty for signed-out visitors and buyers
  // with no purchase history — no cold-start guessing.
  const recommendedIds = useLiveQuery(() => db.recommendedEvents.toArray(), [], []);
  const recommendedEvents = useLiveQuery(async () => {
    if (!recommendedIds || recommendedIds.length === 0) return [];
    const rows = await Promise.all(recommendedIds.map((r) => db.events.get(r.id)));
    return rows.filter((e): e is NonNullable<typeof e> => !!e);
  }, [recommendedIds]);

  const filtered = useMemo(() => {
    if (!events) return undefined;
    const q = query.trim().toLowerCase();
    return events.filter((e) => {
      if (e.status === "CANCELLED") return false;
      const matchesCategory = category === "All" || e.category === category;
      const matchesQuery =
        !q ||
        e.title.toLowerCase().includes(q) ||
        e.city.toLowerCase().includes(q) ||
        e.venue.toLowerCase().includes(q);
      const matchesVendors =
        !vendorsOnly || (e.vendorApplicationsOpen && new Date(e.startsAt) > new Date());
      return matchesCategory && matchesQuery && matchesVendors;
    });
  }, [events, category, query, vendorsOnly]);

  return (
    <div>
      {!online && (
        <p className="mb-6 inline-flex items-center gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
          {t("home.offlineNotice")}
        </p>
      )}

      {recommendedEvents && recommendedEvents.length > 0 && (
        <section className="mb-10">
          <h2 className="mb-4 text-xl font-bold">Events you might like</h2>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {recommendedEvents.map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
          </div>
        </section>
      )}

      <h2 className="mb-4 text-xl font-bold">Your synced events</h2>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={`rounded-full border px-4 py-1.5 text-sm font-medium transition ${
                category === c
                  ? "border-accent bg-accent text-background"
                  : "border-border bg-surface2 text-muted hover:text-foreground"
              }`}
            >
              {c === "All" ? t("home.categoryAll") : c}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setVendorsOnly((v) => !v)}
            className={`shrink-0 rounded-full border px-4 py-1.5 text-sm font-medium transition ${
              vendorsOnly
                ? "border-accent bg-accent text-background"
                : "border-border bg-surface2 text-muted hover:text-foreground"
            }`}
          >
            Vendors welcome
          </button>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("home.searchPlaceholder")}
            className="input sm:max-w-xs"
          />
        </div>
      </div>

      {filtered === undefined ? (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="card aspect-[16/9] animate-pulse bg-surface2" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="card p-12 text-center text-muted">
          {events && events.length === 0 ? t("home.noEventsCached") : t("home.noEventsMatch")}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((event) => (
            <EventCard key={event.id} event={event} />
          ))}
        </div>
      )}
    </div>
  );
}
