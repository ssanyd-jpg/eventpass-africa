import type { Metadata } from "next";
import Link from "next/link";
import PublicEventCard from "@/components/PublicEventCard";
import { getPublicEvents, getPublicEventCities } from "@/lib/marketplace";
import { EVENT_TYPES, EVENT_MODE_CONFIG } from "@/lib/event-modes";

export const metadata: Metadata = {
  title: "Browse events — Chaap",
  description:
    "Discover upcoming marathons, football matches, conferences, concerts, and festivals across East Africa. Buy tickets and pay cashless with Chaap.",
};

interface EventsPageProps {
  searchParams: {
    page?: string;
    eventType?: string;
    city?: string;
    dateFrom?: string;
    dateTo?: string;
    search?: string;
  };
}

export default async function EventsPage({ searchParams: params }: EventsPageProps) {
  const filters = {
    page: params.page ? Number(params.page) : 1,
    eventType: params.eventType || undefined,
    city: params.city || undefined,
    dateFrom: params.dateFrom || undefined,
    dateTo: params.dateTo || undefined,
    search: params.search || undefined,
  };

  const [{ events, total, page, pageCount }, cities] = await Promise.all([
    getPublicEvents(filters),
    getPublicEventCities(),
  ]);

  const hasActiveFilters = Boolean(
    filters.eventType || filters.city || filters.dateFrom || filters.dateTo || filters.search
  );

  function pageHref(targetPage: number) {
    const qs = new URLSearchParams();
    if (filters.eventType) qs.set("eventType", filters.eventType);
    if (filters.city) qs.set("city", filters.city);
    if (filters.dateFrom) qs.set("dateFrom", filters.dateFrom);
    if (filters.dateTo) qs.set("dateTo", filters.dateTo);
    if (filters.search) qs.set("search", filters.search);
    if (targetPage > 1) qs.set("page", String(targetPage));
    const query = qs.toString();
    return query ? `/events?${query}` : "/events";
  }

  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-8 sm:px-6">
      <div className="mb-8">
        <h1 className="text-2xl font-bold sm:text-3xl">Browse events</h1>
        <p className="mt-2 text-muted">
          {total} upcoming event{total === 1 ? "" : "s"} across East Africa
        </p>
      </div>

      <form method="GET" className="card mb-8 grid grid-cols-1 gap-4 p-5 sm:grid-cols-2 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <label className="label" htmlFor="search">Search</label>
          <input
            id="search"
            name="search"
            defaultValue={filters.search ?? ""}
            placeholder="Event or organiser name"
            className="input"
          />
        </div>
        <div>
          <label className="label" htmlFor="eventType">Event type</label>
          <select id="eventType" name="eventType" defaultValue={filters.eventType ?? ""} className="input">
            <option value="">All types</option>
            {EVENT_TYPES.map((type) => (
              <option key={type} value={type}>{EVENT_MODE_CONFIG[type].label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="city">City</label>
          <select id="city" name="city" defaultValue={filters.city ?? ""} className="input">
            <option value="">All cities</option>
            {cities.map((city) => (
              <option key={city} value={city}>{city}</option>
            ))}
          </select>
        </div>
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="label" htmlFor="dateFrom">From</label>
            <input id="dateFrom" type="date" name="dateFrom" defaultValue={filters.dateFrom ?? ""} className="input" />
          </div>
          <div className="flex-1">
            <label className="label" htmlFor="dateTo">To</label>
            <input id="dateTo" type="date" name="dateTo" defaultValue={filters.dateTo ?? ""} className="input" />
          </div>
        </div>
        <div className="flex items-end gap-2 lg:col-span-5">
          <button type="submit" className="btn-primary">Apply filters</button>
          {hasActiveFilters && (
            <Link href="/events" className="btn-secondary">Clear</Link>
          )}
        </div>
      </form>

      {events.length === 0 ? (
        <div className="card p-12 text-center text-muted">No events match your filters.</div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {events.map((event) => (
            <PublicEventCard key={event.id} event={event} />
          ))}
        </div>
      )}

      {pageCount > 1 && (
        <nav className="mt-10 flex items-center justify-center gap-3" aria-label="Pagination">
          <Link
            href={pageHref(Math.max(1, page - 1))}
            aria-disabled={page <= 1}
            className={`btn-secondary ${page <= 1 ? "pointer-events-none opacity-50" : ""}`}
          >
            ← Previous
          </Link>
          <span className="px-3 text-sm text-muted">Page {page} of {pageCount}</span>
          <Link
            href={pageHref(Math.min(pageCount, page + 1))}
            aria-disabled={page >= pageCount}
            className={`btn-secondary ${page >= pageCount ? "pointer-events-none opacity-50" : ""}`}
          >
            Next →
          </Link>
        </nav>
      )}
    </div>
  );
}
