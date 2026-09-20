import Link from "next/link";
import { getFeaturedEvents, getPlatformStats } from "@/lib/marketplace";
import { formatCents } from "@/lib/format";
import HomeBrowse from "@/components/HomeBrowse";

const FEATURES = [
  { title: "EVENT REGISTRATION", description: "Simple. Secure. Scalable.", icon: "ticket" },
  { title: "SECURE PAYMENTS", description: "Multiple local & global options.", icon: "card" },
  { title: "ATTENDEE MANAGEMENT", description: "Everything in one place.", icon: "people" },
  { title: "REAL-TIME ANALYTICS", description: "Data that drives better events.", icon: "chart" },
  { title: "SPORTS & COMPETITIONS", description: "From local to global.", icon: "trophy" },
  { title: "EVENT PROMOTION", description: "Reach more people.", icon: "megaphone" },
  { title: "CHECK-IN SOLUTIONS", description: "QR, RFID & beyond.", icon: "qr" },
] as const;

function FeatureIcon({ type }: { type: (typeof FEATURES)[number]["icon"] }) {
  const common = {
    width: 34,
    height: 34,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  switch (type) {
    case "ticket":
      return <svg {...common}><path d="M4 6h16v12H4z" /><path d="M8 6v3M8 15v3M16 6v3M16 15v3M9 12h6" /></svg>;
    case "card":
      return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 9h18M7 14h4" /></svg>;
    case "people":
      return <svg {...common}><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M3.5 18c.7-3 2.5-4.5 5.5-4.5S13.8 15 14.5 18M14 14.5c2.8-.4 5 .9 6 3.5" /></svg>;
    case "chart":
      return <svg {...common}><path d="M4 19V5M4 19h16" /><rect x="7" y="13" width="2.5" height="4" /><rect x="11" y="10" width="2.5" height="7" /><rect x="15" y="7" width="2.5" height="10" /></svg>;
    case "trophy":
      return <svg {...common}><path d="M8 4h8v4a4 4 0 0 1-8 0V4Z" /><path d="M8 6H5a3 3 0 0 0 3 3M16 6h3a3 3 0 0 1-3 3M12 12v4M8 20h8M9 16h6" /></svg>;
    case "megaphone":
      return <svg {...common}><path d="M4 12h4l8-4v8l-8-4H4z" /><path d="M8 15l1.5 4H7l-2-5M19 9l2-1M19 15l2 1M20 12h2" /></svg>;
    default:
      return <svg {...common}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 8h.01M12 8h.01M16 8h.01M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01" /></svg>;
  }
}

function Arrow() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function EventDate({ startsAt }: { startsAt: string | Date }) {
  const date = new Date(startsAt);
  return (
    <div className="chaap-event-date">
      <span>{date.toLocaleDateString("en-US", { month: "short" }).toUpperCase()}</span>
      <strong>{date.getDate()}</strong>
    </div>
  );
}

export default async function HomePage() {
  const [featuredEvents, stats] = await Promise.all([
    getFeaturedEvents(4),
    getPlatformStats(),
  ]);

  return (
    <div className="chaap-home">
      <section className="chaap-reference-hero">
        <div className="chaap-reference-art" aria-hidden="true" />
        <div className="chaap-reference-overlay" aria-hidden="true" />

        <div className="mx-auto flex min-h-[530px] max-w-[1440px] items-start px-5 sm:px-8 lg:px-10">
          <div className="chaap-reference-copy relative z-10">
            <p className="chaap-reference-kicker">AFRICA&apos;S EVENT PLATFORM</p>

            <h1 className="chaap-reference-title">
              <span className="silver">CONNECT.</span>
              <span className="blue">MANAGE.</span>
              <span className="gold">EXPERIENCE.</span>
            </h1>

            <p className="chaap-reference-lead">
              CHAAP Africa is the all-in-one event platform
              <br className="hidden sm:block" /> for a more connected Africa.
            </p>

            <div className="mt-5 flex flex-col gap-3 sm:flex-row">
              <Link href="/register" className="btn-primary chaap-reference-primary">
                CREATE AN EVENT <Arrow />
              </Link>
              <Link href="/events" className="btn-secondary chaap-reference-secondary">
                EXPLORE EVENTS <Arrow />
              </Link>
            </div>
          </div>

          <div className="chaap-reference-sidecopy">
            <span>PEOPLE</span>
            <span>EVENTS</span>
            <span>EXPERIENCES</span>
            <strong>A STRONGER AFRICA</strong>
          </div>
        </div>

        <div className="chaap-reference-stats">
          <div>
            <strong>{stats.totalEventsHosted.toLocaleString()}+</strong>
            <span>EVENTS</span>
          </div>
          <div>
            <strong>{stats.totalTicketsSold.toLocaleString()}+</strong>
            <span>ATTENDEES</span>
          </div>
          <div>
            <strong>{formatCents(stats.totalCashlessVolumeCents, stats.currency)}</strong>
            <span>CASHLESS VOLUME</span>
          </div>
          <div>
            <strong>AFRICA</strong>
            <span>ONE CONNECTED PLATFORM</span>
          </div>
        </div>
      </section>

      <section id="solutions" className="chaap-reference-features">
        <div>
          {FEATURES.map((feature) => (
            <div key={feature.title} className="chaap-feature">
              <div className="chaap-feature-icon">
                <FeatureIcon type={feature.icon} />
              </div>
              <h3>{feature.title}</h3>
              <p>{feature.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-[#03080e] py-7 sm:py-9" id="events">
        <div className="mx-auto max-w-[1440px] px-5 sm:px-8 lg:px-10">
          <div className="mb-5 flex items-end justify-between gap-4">
            <div>
              <p className="text-[10px] font-extrabold tracking-[0.24em] text-[#16b9ff]">DISCOVER WHAT&apos;S HAPPENING</p>
              <h2 className="mt-1 text-2xl font-black uppercase tracking-tight text-white sm:text-3xl">Upcoming events</h2>
              <div className="mt-2 h-[2px] w-12 bg-[#f6bf22]" />
            </div>
            <Link href="/events" className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-[#16b9ff]">
              View all events <Arrow />
            </Link>
          </div>

          {featuredEvents.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {featuredEvents.map((event) => (
                <Link key={event.id} href={"/events/" + event.slug} className="chaap-event-card group">
                  <div className="relative aspect-[16/10] overflow-hidden">
                    <img
                      src={event.imageUrl}
                      alt={event.title}
                      className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
                      loading="lazy"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/5 to-transparent" />
                    <EventDate startsAt={event.startsAt} />
                    <div className="absolute bottom-3 left-3 right-3">
                      <h3 className="line-clamp-2 text-sm font-extrabold uppercase leading-tight text-white">{event.title}</h3>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3 bg-[#071019] px-3 py-3">
                    <p className="truncate text-xs text-white/60">{event.city}</p>
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 text-white/65 transition group-hover:border-[#16b9ff]/60 group-hover:text-white">
                      <Arrow />
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-white/10 bg-[#071019] p-10 text-center text-sm text-white/50">
              New events are being prepared. Check back soon.
            </div>
          )}
        </div>
      </section>

      <section className="border-t border-white/10 bg-[#02060b] py-14" id="about">
        <div className="mx-auto grid max-w-7xl gap-8 px-5 sm:px-8 lg:grid-cols-[1.1fr_.9fr] lg:items-center">
          <div>
            <p className="text-[10px] font-extrabold tracking-[0.3em] text-[#16b9ff]">BUILT FOR AFRICA</p>
            <h2 className="mt-3 max-w-3xl text-3xl font-black uppercase tracking-tight text-white sm:text-5xl">
              Connect people. Manage events. Create experiences.
            </h2>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-white/55 sm:text-base">
              From registration and ticketing to secure payments, check-in, RFID and real-time event operations, CHAAP brings the moving parts together.
            </p>
          </div>
          <div className="lg:text-right">
            <Link href="/register" className="btn-primary chaap-reference-primary">
              CREATE YOUR EVENT <Arrow />
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-5 pb-16 pt-8 sm:px-8" id="contact">
        <HomeBrowse />
      </section>
    </div>
  );
}
