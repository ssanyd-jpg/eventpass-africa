import Link from "next/link";
import { formatDate } from "@/lib/format";
import type { ActiveFeaturedEntry } from "@/lib/chaap-ads";

// Chaap Ads marketplace — one card in the FEATURED row on /events, below
// the SPOTLIGHT card. Same honesty rule as SpotlightEventCard: the
// "Featured" badge is small but never hidden.
export default function FeaturedEventCard({ listing }: { listing: ActiveFeaturedEntry }) {
  const { event } = listing;
  return (
    <Link
      href={`/events/${event.slug}`}
      className="card group overflow-hidden transition duration-300 hover:-translate-y-1 hover:border-accent"
    >
      <div className="relative aspect-[16/9] w-full overflow-hidden bg-surface2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={event.imageUrl}
          alt={event.title}
          className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
          loading="lazy"
          decoding="async"
        />
        <span className="absolute left-3 top-3 rounded-full border border-accent/40 bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent-hover backdrop-blur">
          Featured
        </span>
      </div>
      <div className="space-y-1.5 p-4">
        <p className="text-xs font-medium text-muted">{formatDate(event.startsAt)}</p>
        <h3 className="text-balance font-semibold leading-snug transition group-hover:text-accent-hover">{event.title}</h3>
        <p className="text-sm text-muted">
          {event.venue} · {event.city}
        </p>
        <p className="text-xs text-muted">by {event.organizerName}</p>
      </div>
    </Link>
  );
}
