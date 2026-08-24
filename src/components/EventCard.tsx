import Link from "next/link";
import type { LocalEvent } from "@/lib/db";
import { formatCents, formatDate } from "@/lib/format";

export default function EventCard({ event }: { event: LocalEvent }) {
  const lowestPrice = event.ticketTypes.length
    ? Math.min(...event.ticketTypes.map((tt) => tt.priceCents))
    : null;
  const soldOut =
    event.ticketTypes.length > 0 &&
    event.ticketTypes.every((tt) => tt.quantitySold >= tt.quantityTotal);

  return (
    <Link
      href={`/events/${event.slug}`}
      className="card group overflow-hidden transition hover:border-accent"
    >
      <div className="relative aspect-[16/9] w-full overflow-hidden bg-surface2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={event.imageUrl}
          alt={event.title}
          className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
          loading="lazy"
        />
        <span className="absolute left-3 top-3 rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium text-white backdrop-blur">
          {event.category}
        </span>
        {event.syncStatus === "pending" && (
          <span className="absolute right-3 top-3 rounded-full bg-warn/90 px-2.5 py-1 text-xs font-semibold text-black">
            Pending sync
          </span>
        )}
        {soldOut && (
          <span className="absolute bottom-3 right-3 rounded-full bg-danger/90 px-2.5 py-1 text-xs font-semibold text-white">
            Sold out
          </span>
        )}
      </div>
      <div className="space-y-1.5 p-4">
        <p className="text-xs font-medium text-muted">{formatDate(event.startsAt)}</p>
        <h3 className="text-balance font-semibold leading-snug">{event.title}</h3>
        <p className="text-sm text-muted">
          {event.venue} · {event.city}
        </p>
        {lowestPrice !== null && (
          <p className="pt-1 text-sm font-semibold text-accent-hover">
            From {formatCents(lowestPrice, event.currency)}
          </p>
        )}
      </div>
    </Link>
  );
}
