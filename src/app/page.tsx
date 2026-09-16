import Link from "next/link";
import { getFeaturedEvents, getPlatformStats } from "@/lib/marketplace";
import { formatCents } from "@/lib/format";
import PublicEventCard from "@/components/PublicEventCard";
import HomeBrowse from "@/components/HomeBrowse";

const HOW_IT_WORKS = [
  {
    title: "Buy your ticket",
    description: "Browse events and buy tickets online or offline — synced automatically once you're back online.",
  },
  {
    title: "Get your wristband",
    description: "Tap your wristband at the gate for instant check-in. No printing, no paper tickets.",
  },
  {
    title: "Tap to pay",
    description: "Load your wallet and tap to pay at any vendor on-site — no cash, no queues.",
  },
];

// Server Component: fetches live platform data (featured events, stats) via
// Prisma directly, so the marketing sections below are real server-rendered
// HTML a crawler (or a slow first paint) can see immediately. The old
// homepage — fully "use client", reading events out of Dexie/IndexedDB —
// still exists, unchanged in behavior, as <HomeBrowse /> beneath these
// sections: that's the offline-first buyer app, not the public marketplace,
// and Session 25 only adds a discovery layer on top of it.
export default async function HomePage() {
  const [featuredEvents, stats] = await Promise.all([getFeaturedEvents(3), getPlatformStats()]);

  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-8 sm:px-6">
      <section className="mb-12 overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-accent-soft via-surface to-surface p-8 sm:p-12">
        <p className="mb-3 text-xs font-bold tracking-[0.3em] text-silver">EAST AFRICA&apos;S EVENT PLATFORM</p>
        <h1 className="max-w-xl text-balance text-3xl font-bold leading-tight sm:text-4xl">
          Chaap — East Africa&apos;s event platform
        </h1>
        <p className="mt-3 max-w-lg text-muted">
          Buy tickets, get your wristband, and tap to pay — cashless and built to work offline, anywhere in East
          Africa.
        </p>
        <Link href="/events" className="btn-primary mt-6 inline-flex">
          Browse events
        </Link>
      </section>

      {featuredEvents.length > 0 && (
        <section className="mb-12">
          <h2 className="mb-4 text-xl font-bold">Featured events</h2>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {featuredEvents.map((event) => (
              <PublicEventCard key={event.id} event={event} />
            ))}
          </div>
        </section>
      )}

      <section className="mb-12">
        <h2 className="mb-4 text-xl font-bold">How it works</h2>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          {HOW_IT_WORKS.map((step, i) => (
            <div key={step.title} className="card p-5">
              <span className="pill mb-3 inline-flex border-accent/40 bg-accent-soft text-accent-hover">
                Step {i + 1}
              </span>
              <h3 className="font-semibold">{step.title}</h3>
              <p className="mt-1 text-sm text-muted">{step.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mb-12 grid grid-cols-1 gap-6 rounded-2xl border border-border bg-surface2 p-8 sm:grid-cols-3">
        <div>
          <p className="text-3xl font-bold tabular-nums">{stats.totalEventsHosted.toLocaleString()}</p>
          <p className="mt-1 text-sm text-muted">Events hosted</p>
        </div>
        <div>
          <p className="text-3xl font-bold tabular-nums">{stats.totalTicketsSold.toLocaleString()}</p>
          <p className="mt-1 text-sm text-muted">Tickets sold</p>
        </div>
        <div>
          <p className="text-3xl font-bold tabular-nums">
            {formatCents(stats.totalCashlessVolumeCents, stats.currency)}
          </p>
          <p className="mt-1 text-sm text-muted">Cashless volume processed</p>
        </div>
      </section>

      <HomeBrowse />
    </div>
  );
}
