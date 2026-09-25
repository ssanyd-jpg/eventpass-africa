import Link from "next/link";
import { getFeaturedEvents, getPlatformStats } from "@/lib/marketplace";
import { formatCents } from "@/lib/format";
import PublicEventCard from "@/components/PublicEventCard";
import HomeBrowse from "@/components/HomeBrowse";

function TicketIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-6 w-6">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v1.5a1.5 1.5 0 0 0 0 3V15a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1.5a1.5 1.5 0 0 0 0-3V9Z"
      />
      <path strokeLinecap="round" d="M10 7v10" strokeDasharray="1.5 2.5" />
    </svg>
  );
}

function WristbandIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-6 w-6">
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 8.5c-2 1-3 2.2-3 3.5s1 2.5 3 3.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M17 8.5c2 1 3 2.2 3 3.5s-1 2.5-3 3.5" />
      <rect x="7" y="6.5" width="10" height="11" rx="2.5" />
      <path strokeLinecap="round" d="M10 10.5h4M10 13.5h4" />
    </svg>
  );
}

function TapIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-6 w-6">
      <path strokeLinecap="round" d="M8.5 14.5a5 5 0 0 1 0-7" />
      <path strokeLinecap="round" d="M5.8 17.2a9 9 0 0 1 0-12.7" />
      <circle cx="15" cy="11" r="1.4" fill="currentColor" stroke="none" />
      <path strokeLinecap="round" d="M12.5 13.5 17 18M13.5 18l-1-4.5 4.5-1" strokeLinejoin="round" />
    </svg>
  );
}

function PulseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-6 w-6">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h4l2 6 4-12 2 6h6" />
    </svg>
  );
}

function PhoneMoneyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-6 w-6">
      <rect x="7" y="3" width="10" height="18" rx="2" />
      <path strokeLinecap="round" d="M11 18h2" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.5 11.5a2 2 0 1 1 2.6 1.9c-1 .3-1.6.9-1.6 1.6" />
      <path strokeLinecap="round" d="M11.4 16.7h.1" />
    </svg>
  );
}

function OfflineSyncIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-6 w-6">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 9.5a11 11 0 0 1 6.5-3.3M19.9 9.5A11 11 0 0 0 13 6" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 13.2a6.3 6.3 0 0 1 3.8-1.9" />
      <path strokeLinecap="round" d="M3 3l18 18" />
      <circle cx="12" cy="18" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

const HOW_IT_WORKS = [
  {
    icon: TicketIcon,
    title: "Buy your ticket",
    description: "Pay with M-Pesa or card in a couple of taps — online or offline, synced the moment you're back.",
  },
  {
    icon: WristbandIcon,
    title: "Get your wristband",
    description: "Tap your NFC wristband at the gate for instant check-in. No printing, no paper tickets.",
  },
  {
    icon: TapIcon,
    title: "Tap to pay",
    description: "Load your wallet and tap to pay at any vendor on-site — no cash, no queues.",
  },
];

const EVENT_TYPES = [
  { emoji: "🏃", title: "Marathons", description: "Chip timing and cashless refreshment stations along the route." },
  { emoji: "🎪", title: "Festivals", description: "Multi-vendor cashless payments across every stage and stall." },
  { emoji: "⚽", title: "Football", description: "Season tickets, member access control, and gate scanning." },
  { emoji: "🎤", title: "Conferences", description: "Badge scanning, session check-in, and lead capture for sponsors." },
];

const FOR_ORGANISERS = [
  {
    icon: PulseIcon,
    title: "Real-time monitoring",
    description: "Watch sales, check-ins, and vendor payouts update live from any device.",
  },
  {
    icon: PhoneMoneyIcon,
    title: "All mobile money networks",
    description: "Accept M-Pesa, Airtel, HaloPesa and cards through AirPay Tanzania — one integration, every payment method.",
  },
  {
    icon: OfflineSyncIcon,
    title: "Works offline",
    description: "Gates and vendors keep running through a dead signal, then sync once you're back.",
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
    <div>
      {/* Hero — capped so the stats card below peeks into view on first
          load, hinting that there's more to scroll to. This deliberately
          isn't a flat "85vh" anymore: a height expressed as a pure viewport
          percentage combined with the navbar's fixed ~98px eats a "leftover"
          gap that itself scales with viewport height, so any fixed overlap
          margin tuned for one phone's leftover lands mid-word through the
          stats label's text on another (verified: sliced clean through
          "Live on Chaap right now" at 375x667 while looking fine at
          390x844). Pinning the leftover to a constant 16px via calc() —
          100dvh minus the navbar and that 16px — keeps the peek a blank
          sliver of the card's top edge on every phone height, never mid-
          label, while still landing around ~85% of the viewport on typical
          phone sizes. dvh has a vh fallback for older browsers. Reset to a
          normal content-sized block from sm up, where there's enough width
          for the hero to read fine without a height cap. */}
      <section className="relative flex min-h-[calc(100vh-114px)] min-h-[calc(100dvh-114px)] flex-col justify-center overflow-hidden border-b border-border bg-gunmetal sm:block sm:min-h-0">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            backgroundImage: "radial-gradient(rgba(217,217,217,0.12) 1px, transparent 1px)",
            backgroundSize: "24px 24px",
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-accent/25 blur-[90px]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-32 -right-16 h-80 w-80 rounded-full bg-crimson/20 blur-[100px]"
        />

        <div className="relative mx-auto max-w-6xl px-4 pb-14 pt-14 sm:px-6 sm:pb-20 sm:pt-20">
          <p className="mb-4 text-xs font-bold tracking-[0.3em] text-silver">EAST AFRICA&apos;S EVENT PLATFORM</p>
          <h1 className="max-w-2xl text-balance font-display text-4xl font-extrabold leading-[1.05] tracking-tight text-foreground sm:text-5xl lg:text-6xl">
            East Africa&apos;s <span className="text-accent-hover">cashless</span> event platform.
          </h1>
          <p className="mt-5 max-w-lg text-balance text-base text-muted sm:text-lg">
            Buy tickets, tap your wristband, pay at any vendor — works offline, anywhere.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link href="/events" className="btn-primary w-full sm:w-auto">
              Browse events
            </Link>
            <Link href="/login" className="btn-secondary w-full sm:w-auto">
              For organisers
            </Link>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
        {/* Social proof / live stats */}
        <section className="mb-14 rounded-2xl border border-border bg-surface p-6 shadow-lg shadow-black/20 sm:-mt-10 sm:p-8">
          <p className="mb-5 text-xs font-bold uppercase tracking-[0.2em] text-muted">Live on Chaap right now</p>
          <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <div className="pb-5 sm:px-6 sm:pb-0 sm:first:pl-0">
              <p className="font-display text-3xl font-extrabold tabular-nums text-foreground sm:text-4xl">
                {stats.totalEventsHosted.toLocaleString()}
              </p>
              <p className="mt-1 text-sm text-muted">Events hosted</p>
            </div>
            <div className="py-5 sm:px-6 sm:py-0">
              <p className="font-display text-3xl font-extrabold tabular-nums text-foreground sm:text-4xl">
                {stats.totalTicketsSold.toLocaleString()}
              </p>
              <p className="mt-1 text-sm text-muted">Tickets sold</p>
            </div>
            <div className="pt-5 sm:px-6 sm:pt-0 sm:last:pr-0">
              <p className="font-display text-3xl font-extrabold tabular-nums text-foreground sm:text-4xl">
                {formatCents(stats.totalCashlessVolumeCents, stats.currency)}
              </p>
              <p className="mt-1 text-sm text-muted">Cashless volume processed</p>
            </div>
          </div>
        </section>

        {featuredEvents.length > 0 && (
          <section className="mb-14">
            <h2 className="mb-4 font-display text-xl font-bold">Featured events</h2>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {featuredEvents.map((event) => (
                <PublicEventCard key={event.id} event={event} />
              ))}
            </div>
          </section>
        )}

        {/* How it works */}
        <section className="mb-14">
          <h2 className="mb-1 font-display text-xl font-bold sm:text-2xl">How it works</h2>
          <p className="mb-6 text-sm text-muted">From ticket to tap-to-pay in three steps.</p>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
            {HOW_IT_WORKS.map((step, i) => (
              <div key={step.title} className="card relative p-5">
                <span className="absolute right-5 top-5 font-display text-3xl font-extrabold text-border">
                  {i + 1}
                </span>
                <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-full border border-accent/40 bg-accent-soft text-accent-hover">
                  <step.icon />
                </div>
                <h3 className="font-semibold">{step.title}</h3>
                <p className="mt-1 text-sm text-muted">{step.description}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Event types */}
        <section className="mb-14">
          <h2 className="mb-1 font-display text-xl font-bold sm:text-2xl">Built for every kind of event</h2>
          <p className="mb-6 text-sm text-muted">One platform, tuned for how each event actually runs.</p>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {EVENT_TYPES.map((type) => (
              <div key={type.title} className="card p-5">
                <span className="text-2xl">{type.emoji}</span>
                <h3 className="mt-3 font-semibold">{type.title}</h3>
                <p className="mt-1 text-sm text-muted">{type.description}</p>
              </div>
            ))}
          </div>
        </section>

        {/* For organisers */}
        <section className="mb-14 rounded-2xl border border-border bg-surface2 p-6 sm:p-8">
          <h2 className="mb-1 font-display text-xl font-bold sm:text-2xl">For organisers</h2>
          <p className="mb-6 text-sm text-muted">Everything you need to run the day, without watching your signal bars.</p>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
            {FOR_ORGANISERS.map((item) => (
              <div key={item.title}>
                <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-full border border-accent/40 bg-accent-soft text-accent-hover">
                  <item.icon />
                </div>
                <h3 className="font-semibold">{item.title}</h3>
                <p className="mt-1 text-sm text-muted">{item.description}</p>
              </div>
            ))}
          </div>
          <Link href="/login" className="btn-primary mt-7 inline-flex">
            For organisers
          </Link>
        </section>

        <HomeBrowse />
      </div>

      {/* Footer */}
      <footer className="border-t border-border bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
          <div className="grid grid-cols-1 gap-8 sm:grid-cols-3">
            <div>
              <div className="flex items-center gap-2.5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/chaap-icon.webp" alt="" className="h-8 w-8 rounded-lg" />
                <span className="font-display text-base font-extrabold tracking-tight text-silver">CHAAP</span>
              </div>
              <p className="mt-3 max-w-xs text-sm text-muted">East Africa&apos;s event platform.</p>
            </div>
            <div>
              <p className="label">Platform</p>
              <div className="flex flex-col gap-2 text-sm">
                <Link href="/events" className="text-muted transition hover:text-foreground">
                  Browse events
                </Link>
                <Link href="/login" className="text-muted transition hover:text-foreground">
                  For organisers
                </Link>
              </div>
            </div>
            <div>
              <p className="label">Follow Chaap</p>
              <p className="text-sm text-muted">@chaapafrica on Instagram, X &amp; TikTok</p>
            </div>
          </div>
          <div className="mt-8 border-t border-border pt-6 text-xs text-muted">
            © {new Date().getFullYear()} Chaap. East Africa&apos;s event platform.
          </div>
        </div>
      </footer>
    </div>
  );
}
