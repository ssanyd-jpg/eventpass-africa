import Link from "next/link";
import { formatCents, formatDate } from "@/lib/format";
import { computeEventPricing, EVENT_TYPE_BADGE_COLORS, type PublicEventListItem } from "@/lib/marketplace";
import type { EventType } from "@/lib/event-modes";

// Server-renderable card for the public marketplace (/events, homepage
// featured section) — distinct from the Dexie/offline-buyer-app EventCard,
// which reads LocalEvent (IndexedDB) shape and has its own badge set. This
// one only ever sees plain Prisma-shaped data, no Dexie import, so it's safe
// to render in a Server Component with no hydration cost.
export default function PublicEventCard({ event }: { event: PublicEventListItem }) {
  const { lowestPriceCents, soldOut, isFree, sellingFast } = computeEventPricing(event.ticketTypes);
  const badgeColor = EVENT_TYPE_BADGE_COLORS[event.eventType as EventType] ?? EVENT_TYPE_BADGE_COLORS.GENERAL;

  return (
    <Link
      href={`/events/${event.slug}`}
      className="card group overflow-hidden transition duration-300 hover:-translate-y-1 hover:border-accent hover:shadow-lg hover:shadow-black/30"
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
        {/* Gradient wash so the badges (and, on hover, the scaled-up photo
            underneath) always keep readable contrast regardless of how
            light the source image is. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/0 to-black/30"
        />
        <span className={`absolute left-3 top-3 rounded-full border px-2.5 py-1 text-xs font-semibold backdrop-blur ${badgeColor}`}>
          {event.eventType}
        </span>
        {soldOut ? (
          <span className="absolute bottom-3 right-3 rounded-full bg-danger/90 px-2.5 py-1 text-xs font-semibold text-white">
            Sold out
          </span>
        ) : sellingFast ? (
          <span className="absolute bottom-3 right-3 rounded-full bg-warn/90 px-2.5 py-1 text-xs font-semibold text-white">
            🔥 Selling fast
          </span>
        ) : isFree ? (
          <span className="absolute bottom-3 right-3 rounded-full bg-accent/90 px-2.5 py-1 text-xs font-semibold text-white">
            Free
          </span>
        ) : null}
      </div>
      <div className="space-y-1.5 p-4">
        <p className="text-xs font-medium text-muted">{formatDate(event.startsAt)}</p>
        <h3 className="text-balance font-semibold leading-snug transition group-hover:text-accent-hover">
          {event.title}
        </h3>
        <p className="text-sm text-muted">
          {event.venue} · {event.city}
        </p>
        <p className="text-xs text-muted">by {event.organizerName}</p>
        {lowestPriceCents !== null && !isFree && (
          <p className="pt-1 text-sm font-semibold text-accent-hover">
            From {formatCents(lowestPriceCents, event.currency)}
          </p>
        )}
      </div>
    </Link>
  );
}
