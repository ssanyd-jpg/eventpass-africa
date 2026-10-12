import Link from "next/link";
import { getFeaturedEvents, getPlatformStats } from "@/lib/marketplace";
import { formatCents } from "@/lib/format";
import PublicEventCard from "@/components/PublicEventCard";
import HomeBrowse from "@/components/HomeBrowse";
import HomeOrganiserBanner from "@/components/HomeOrganiserBanner";
import ForOrganisersLink from "@/components/ForOrganisersLink";
import HeroBrandVideo from "@/components/HeroBrandVideo";
import MarketingLeadForm from "@/components/MarketingLeadForm";

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
    title: "Get your ticket",
    description: "Buy online and pay with mobile money or card — your ticket arrives by WhatsApp, SMS and email.",
  },
  {
    icon: WristbandIcon,
    title: "Tap in",
    description: "Collect your wristband and walk straight through the gate. Top it up from your phone anytime.",
  },
  {
    icon: TapIcon,
    title: "Tap to pay",
    description: "Food, drinks, merch — one tap at any stall, no cash, no change, no waiting for a network.",
  },
];

const EVENT_TYPES = [
  { emoji: "🎪", title: "Festivals & concerts", description: "Shorter bar queues, no cash floats to guard, and guests who spend more." },
  { emoji: "🏃", title: "Marathons & races", description: "Race-day check-in, live results, and cashless spending at the finish village." },
  { emoji: "⚽", title: "Football", description: "Move full stadiums through the gates fast, with fast-track lanes for VIPs." },
  { emoji: "🚵", title: "Mountain biking", description: "Checkpoint timing, elevation tracking, and feed-zone cashless." },
  { emoji: "🎤", title: "Conferences & expos", description: "Session attendance and exhibitor lead capture with a tap, all in one badge." },
];

const WHO_ITS_FOR = [
  {
    title: "Organisers",
    description:
      "See ticket sales, gate traffic and every stall's takings as they happen. Close out the night with numbers that reconcile.",
    tags: ["Live dashboard", "Revenue forecasting", "Full reconciliation"],
    accent: true,
  },
  {
    title: "Vendors",
    description: "Serve faster, never handle cash, and track your sales on your own phone. Settlement lands without the paperwork.",
    tags: ["Tap-to-pay terminal", "Your own sales view", "Settlement by SMS"],
  },
  {
    title: "Sponsors",
    description: "Stop guessing what your activation delivered. Measure real visits and engagement, and know which campaign worked best.",
    tags: ["Measured visits", "Campaign comparison", "Your own portal"],
  },
  {
    title: "Guests",
    description: "No cash to carry, no phone to pull out. Families and groups can share one balance, in Swahili or English.",
    tags: ["Mobile money top-ups", "Group wallets", "Kiswahili"],
  },
];

const WHY_CHAAP = [
  {
    icon: OfflineSyncIcon,
    title: "Keeps going when the network doesn't",
    description: "Gates and stalls keep working through signal drops and crowded networks. Nothing is lost.",
  },
  {
    icon: PhoneMoneyIcon,
    title: "Mobile money, built in",
    description: "Every major Tanzanian network plus cards, in one checkout. No bolted-on workarounds.",
  },
  {
    icon: PulseIcon,
    title: "Your event, live",
    description: "Arrivals, busy stalls and alerts on one screen, so you fix problems before guests notice them.",
  },
];

// Server Component: fetches live platform data (featured events, stats) via
// Prisma directly. This page doubles as the chaap.africa marketing site —
// previously a separate static mockup (see /api/leads's own comment) —
// folded in here rather than hosted separately, since chaap.africa already
// points at this deployment (confirmed: USSD's callback URL in DEPLOYMENT.md
// assumes the app itself answers on that domain). The old homepage — fully
// "use client", reading events out of Dexie/IndexedDB — still exists,
// unchanged in behavior, as <HomeBrowse /> beneath these sections: that's
// the offline-first buyer app, not the public marketplace/pitch above it.
export default async function HomePage() {
  const [featuredEvents, stats] = await Promise.all([getFeaturedEvents(3), getPlatformStats()]);

  return (
    <div>
      <HomeOrganiserBanner />

      {/* Hero */}
      <section className="relative overflow-hidden border-b border-border bg-background">
        <div
          aria-hidden
          className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-accent/25 blur-[90px]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-32 -right-16 h-80 w-80 rounded-full bg-crimson/20 blur-[100px]"
        />

        <div className="relative mx-auto grid max-w-6xl grid-cols-1 items-center gap-10 px-4 pb-14 pt-14 sm:px-6 sm:pb-20 sm:pt-20 lg:grid-cols-[1.1fr_0.9fr]">
          <div>
            <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-surface2 px-3.5 py-1.5 text-xs font-medium text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              Now live across Tanzania
            </p>
            <h1 className="max-w-xl text-balance font-display text-4xl font-extrabold leading-[1.05] tracking-tight text-foreground sm:text-5xl lg:text-6xl">
              One wristband. Every gate. Every sale.
            </h1>
            <p className="mt-5 max-w-lg text-balance text-base text-muted sm:text-lg">
              One platform for ticketing, gate entry and cashless spend — built for East Africa&apos;s events.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a href="#contact" className="btn-primary w-full sm:w-auto">
                Bring Chaap to your event
              </a>
              <Link href="/events" className="btn-secondary w-full sm:w-auto">
                Browse events
              </Link>
            </div>
            <div className="mt-7 flex flex-col gap-2.5">
              <span className="text-xs font-bold uppercase tracking-[0.2em] text-muted">Top up with</span>
              <div className="flex flex-wrap gap-2">
                {["M-Pesa", "Mixx by Yas", "Airtel Money", "Visa", "Mastercard"].map((method) => (
                  <span key={method} className="pill">
                    {method}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="card overflow-hidden shadow-xl shadow-black/30">
            <div className="aspect-[16/9] w-full lg:aspect-[4/3]">
              <HeroBrandVideo src="/brand/chaap-hero.mp4" poster="/brand/chaap-hero-poster.webp" />
            </div>
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
          <h2 className="mb-1 font-display text-xl font-bold sm:text-2xl">Three taps. That&apos;s the whole night.</h2>
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
          <h2 className="mb-1 font-display text-xl font-bold sm:text-2xl">From stadiums to start lines.</h2>
          <p className="mb-6 text-sm text-muted">One platform that adapts to the event you&apos;re running.</p>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {EVENT_TYPES.map((type) => (
              <div key={type.title} className="card p-5">
                <span className="text-2xl">{type.emoji}</span>
                <h3 className="mt-3 font-semibold">{type.title}</h3>
                <p className="mt-1 text-sm text-muted">{type.description}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Who it's for */}
        <section className="mb-14">
          <h2 className="mb-1 font-display text-xl font-bold sm:text-2xl">Everyone at the event wins.</h2>
          <p className="mb-6 text-sm text-muted">One platform, built around every role on event day.</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {WHO_ITS_FOR.map((card) => (
              <div
                key={card.title}
                className={`flex min-h-[220px] flex-col gap-4 rounded-2xl p-7 ${
                  card.accent ? "bg-chrome-sidebar text-on-chrome" : "card"
                }`}
              >
                <h3 className="font-display text-2xl font-extrabold">{card.title}</h3>
                <p className={`max-w-sm text-sm leading-relaxed ${card.accent ? "text-on-chrome/90" : "text-muted"}`}>
                  {card.description}
                </p>
                <div className="mt-auto flex flex-wrap gap-2 text-xs">
                  {card.tags.map((tag) => (
                    <span
                      key={tag}
                      className={`rounded-full px-3 py-1.5 ${
                        card.accent ? "bg-black/25 text-on-chrome" : "bg-surface2 text-muted"
                      }`}
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Why Chaap */}
        <section className="mb-14 rounded-2xl border border-border bg-surface2 p-6 sm:p-8">
          <h2 className="mb-1 font-display text-xl font-bold sm:text-2xl">Built here. For events here.</h2>
          <p className="mb-6 text-sm text-muted">
            Chaap was designed in Tanzania, for East African venues and the way people actually pay.
          </p>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
            {WHY_CHAAP.map((item) => (
              <div key={item.title}>
                <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-full border border-accent/40 bg-accent-soft text-accent-hover">
                  <item.icon />
                </div>
                <h3 className="font-semibold">{item.title}</h3>
                <p className="mt-1 text-sm text-muted">{item.description}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Pricing */}
        <section className="mb-14 flex flex-col items-center gap-6 rounded-2xl border border-border bg-surface p-8 text-center sm:p-12">
          <div className="flex flex-col gap-3">
            <span className="text-xs font-bold uppercase tracking-[0.2em] text-accent-hover">Pricing</span>
            <h2 className="font-display text-2xl font-bold sm:text-3xl">You only pay when you earn.</h2>
            <p className="mx-auto max-w-lg text-sm text-muted">
              No upfront fees to get started. Revenue share only — Chaap earns when you do. Every event is
              different, so we price it with you, not off a rate card.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm text-foreground">
            <span className="flex items-center gap-2">
              <span className="text-accent-hover">✓</span>No setup fee
            </span>
            <span className="flex items-center gap-2">
              <span className="text-accent-hover">✓</span>No hardware to buy
            </span>
            <span className="flex items-center gap-2">
              <span className="text-accent-hover">✓</span>Live dashboard &amp; reconciliation included
            </span>
          </div>
          <a href="#contact" className="btn-primary">
            Get your event&apos;s pricing
          </a>
        </section>

        {/* Contact */}
        <section
          id="contact"
          className="mb-14 grid grid-cols-1 gap-10 rounded-3xl bg-chrome-topbar p-8 text-on-chrome sm:p-12 lg:grid-cols-[1.1fr_0.9fr]"
        >
          <div className="flex flex-col gap-4">
            <h2 className="font-display text-3xl font-extrabold leading-tight sm:text-4xl">
              Planning an event?
              <br />
              Let&apos;s make it Chaap.
            </h2>
            <p className="max-w-md text-sm text-on-chrome/90 sm:text-base">
              Tell us about your event and we&apos;ll show you what cashless looks like for your crowd. No obligation.
            </p>
            <p className="text-sm text-on-chrome/90">
              Email:{" "}
              <a href="mailto:hello@chaap.africa" className="font-semibold text-on-chrome underline">
                hello@chaap.africa
              </a>
            </p>
          </div>
          <MarketingLeadForm />
        </section>

        <HomeBrowse />
      </div>

      {/* Footer */}
      <footer className="border-t border-border bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
          <div className="grid grid-cols-1 gap-8 sm:grid-cols-4">
            <div>
              <div className="flex items-center gap-2.5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/chaap-icon.webp" alt="" className="h-8 w-8 rounded-lg" />
                <span className="font-display text-base font-extrabold tracking-tight text-silver">CHAAP</span>
              </div>
              <p className="mt-3 max-w-xs text-sm text-muted">East Africa&apos;s event platform.</p>
              <p className="mt-1 text-xs text-muted">Dar es Salaam, Tanzania</p>
            </div>
            <div>
              <p className="label">Platform</p>
              <div className="flex flex-col gap-2 text-sm">
                <Link href="/events" className="text-muted transition hover:text-foreground">
                  Browse events
                </Link>
                <ForOrganisersLink className="text-muted transition hover:text-foreground">
                  For organisers
                </ForOrganisersLink>
              </div>
            </div>
            <div>
              <p className="label">Partners</p>
              <div className="flex flex-col gap-2 text-sm">
                <Link href="/login" className="text-muted transition hover:text-foreground">
                  Organiser sign in
                </Link>
                <Link href="/vendor/login" className="text-muted transition hover:text-foreground">
                  Vendor sign in
                </Link>
                <Link href="/sponsor/login" className="text-muted transition hover:text-foreground">
                  Sponsor sign in
                </Link>
              </div>
            </div>
            <div>
              <p className="label">Follow Chaap</p>
              <p className="text-sm text-muted">@chaapafrica on Instagram, X &amp; TikTok</p>
            </div>
          </div>

          <div className="mt-10 border-t border-border pt-8">
            <span className="bg-gradient-to-r from-[#C79BFF] via-[#FF5C9A] to-accent bg-clip-text font-display text-5xl font-extrabold tracking-tight text-transparent sm:text-6xl">
              Fanya Chaap.
            </span>
          </div>

          <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-6 text-xs text-muted">
            <span>© {new Date().getFullYear()} Chaap Africa. All rights reserved.</span>
            <div className="flex items-center gap-4">
              <Link href="/privacy" className="transition hover:text-foreground">
                Privacy
              </Link>
              <Link href="/terms" className="transition hover:text-foreground">
                Terms
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
