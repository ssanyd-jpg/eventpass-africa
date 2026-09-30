import Link from "next/link";
import { formatDate } from "@/lib/format";
import type { ActiveFeaturedEntry } from "@/lib/chaap-ads";

// Chaap Ads marketplace — the one SPOTLIGHT slot's large card at the top of
// /events. "Sponsored" is deliberately visible and unstyled-as-a-secret —
// paid placement must always be honest about being paid (spec item 4).
export default function SpotlightEventCard({ listing }: { listing: ActiveFeaturedEntry }) {
  const { event } = listing;
  return (
    <Link
      href={`/events/${event.slug}`}
      className="card group mb-6 flex flex-col overflow-hidden transition hover:border-accent sm:flex-row"
    >
      <div className="relative aspect-[16/9] w-full overflow-hidden bg-surface2 sm:aspect-auto sm:w-2/5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={event.imageUrl}
          alt={event.title}
          className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
          loading="lazy"
          decoding="async"
        />
      </div>
      <div className="flex flex-1 flex-col justify-center gap-2 p-6">
        <span className="w-fit rounded-full border border-accent/40 bg-accent-soft px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-accent-hover">
          Sponsored
        </span>
        <h3 className="text-xl font-bold leading-snug transition group-hover:text-accent-hover">{event.title}</h3>
        <p className="text-sm text-muted">{formatDate(event.startsAt)}</p>
        <p className="text-sm text-muted">
          {event.venue} · {event.city}
        </p>
        <p className="text-xs text-muted">by {event.organizerName}</p>
      </div>
    </Link>
  );
}
