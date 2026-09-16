import { prisma } from "@/lib/prisma";
import { summarizeWalletActivity } from "@/lib/analytics";
import { DEFAULT_CURRENCY } from "@/lib/currency";
import type { EventType } from "@/lib/event-modes";

export const EVENTS_PAGE_SIZE = 12;

// Color-coded per the event type it represents — MARATHON/FOOTBALL/CONFERENCE/
// GENERAL colors are the ones the product spec pinned down; CONCERT/FESTIVAL
// get the two remaining unused hues so every EVENT_TYPES value has a badge.
export const EVENT_TYPE_BADGE_COLORS: Record<EventType, string> = {
  MARATHON: "border-teal-400/40 bg-teal-400/10 text-teal-600 dark:text-teal-300",
  FOOTBALL: "border-green-400/40 bg-green-400/10 text-green-600 dark:text-green-300",
  CONFERENCE: "border-blue-400/40 bg-blue-400/10 text-blue-600 dark:text-blue-300",
  GENERAL: "border-amber-400/40 bg-amber-400/10 text-amber-600 dark:text-amber-300",
  CONCERT: "border-purple-400/40 bg-purple-400/10 text-purple-600 dark:text-purple-300",
  FESTIVAL: "border-pink-400/40 bg-pink-400/10 text-pink-600 dark:text-pink-300",
};

export interface TicketTypePricing {
  priceCents: number;
  quantityTotal: number;
  quantitySold: number;
}

export interface EventPricing {
  lowestPriceCents: number | null;
  soldOut: boolean;
  isFree: boolean;
}

// Same lowest-price/sold-out logic as EventCard's client-side (Dexie) version
// — kept as its own pure function here so the marketplace's server-rendered
// pages and PublicEventCard can share and unit-test it without dragging in
// the Dexie-typed EventCard.
export function computeEventPricing(ticketTypes: TicketTypePricing[]): EventPricing {
  const lowestPriceCents = ticketTypes.length
    ? Math.min(...ticketTypes.map((tt) => tt.priceCents))
    : null;
  const soldOut =
    ticketTypes.length > 0 && ticketTypes.every((tt) => tt.quantitySold >= tt.quantityTotal);
  const isFree = ticketTypes.length > 0 && ticketTypes.every((tt) => tt.priceCents === 0);
  return { lowestPriceCents, soldOut, isFree };
}

const publicEventSelect = {
  id: true,
  slug: true,
  title: true,
  description: true,
  city: true,
  venue: true,
  startsAt: true,
  imageUrl: true,
  eventType: true,
  currency: true,
  organization: { select: { name: true } },
  ticketTypes: { select: { priceCents: true, quantityTotal: true, quantitySold: true } },
} as const;

export interface PublicEventListItem {
  id: string;
  slug: string;
  title: string;
  description: string;
  city: string;
  venue: string;
  startsAt: Date;
  imageUrl: string;
  eventType: string;
  currency: string;
  organizerName: string;
  ticketTypes: TicketTypePricing[];
}

function shapePublicEvent(event: {
  organization: { name: string };
} & Omit<PublicEventListItem, "organizerName">): PublicEventListItem {
  const { organization, ...rest } = event;
  return { ...rest, organizerName: organization.name };
}

export interface PublicEventsFilters {
  page?: number;
  eventType?: string;
  city?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
}

export interface PublicEventsResult {
  events: PublicEventListItem[];
  total: number;
  page: number;
  pageCount: number;
}

// The public discovery surface's one query — only published (LIVE), only
// upcoming (startsAt in the future relative to `now`), sorted soonest-first.
// `now` is a parameter (not read internally) so tests can pin it exactly the
// way sendEventReminders's tests do, rather than fighting the real clock and
// this suite's shared, never-cleaned-up test database.
export async function getPublicEvents(
  filters: PublicEventsFilters = {},
  now: Date = new Date()
): Promise<PublicEventsResult> {
  const page = Math.max(1, Math.floor(filters.page ?? 1));

  const startsAt: { gte: Date; lt?: Date } = {
    gte: filters.dateFrom && new Date(filters.dateFrom) > now ? new Date(filters.dateFrom) : now,
  };
  if (filters.dateTo) {
    const end = new Date(filters.dateTo);
    end.setDate(end.getDate() + 1); // dateTo is inclusive of that whole day
    startsAt.lt = end;
  }

  const search = filters.search?.trim();

  const where = {
    status: "LIVE",
    startsAt,
    ...(filters.eventType ? { eventType: filters.eventType } : {}),
    ...(filters.city ? { city: { equals: filters.city, mode: "insensitive" as const } } : {}),
    ...(search
      ? {
          OR: [
            { title: { contains: search, mode: "insensitive" as const } },
            { organization: { name: { contains: search, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  const [total, events] = await Promise.all([
    prisma.event.count({ where }),
    prisma.event.findMany({
      where,
      orderBy: { startsAt: "asc" },
      skip: (page - 1) * EVENTS_PAGE_SIZE,
      take: EVENTS_PAGE_SIZE,
      select: publicEventSelect,
    }),
  ]);

  return {
    events: events.map(shapePublicEvent),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / EVENTS_PAGE_SIZE)),
  };
}

// Distinct cities among currently-listable events — used to populate the
// city filter's <select> without hardcoding a city list.
export async function getPublicEventCities(now: Date = new Date()): Promise<string[]> {
  const rows = await prisma.event.findMany({
    where: { status: "LIVE", startsAt: { gte: now } },
    select: { city: true },
    distinct: ["city"],
    orderBy: { city: "asc" },
  });
  return rows.map((r) => r.city);
}

export interface FeaturedEvent extends PublicEventListItem {
  ticketsSold: number;
}

// "Most tickets sold" social proof for the homepage. No Prisma groupBy/sum
// convention exists elsewhere in this codebase for this shape of ranking
// (see topEventsByTicketsSold in analytics.ts, which also just reduces
// flat rows in JS) — same approach here, kept small since only upcoming
// LIVE events are ever candidates.
export async function getFeaturedEvents(limit = 3, now: Date = new Date()): Promise<FeaturedEvent[]> {
  const events = await prisma.event.findMany({
    where: { status: "LIVE", startsAt: { gte: now } },
    select: publicEventSelect,
  });

  return events
    .map(shapePublicEvent)
    .map((event) => ({
      ...event,
      ticketsSold: event.ticketTypes.reduce((sum, tt) => sum + tt.quantitySold, 0),
    }))
    .sort((a, b) => b.ticketsSold - a.ticketsSold)
    .slice(0, limit);
}

export interface PublicEventSeo {
  title: string;
  description: string;
  city: string;
  venue: string;
  startsAt: Date;
  endsAt: Date | null;
  imageUrl: string;
  currency: string;
  organizerName: string;
  status: string;
  ticketTypes: TicketTypePricing[];
}

// Minimal fetch for generateMetadata + JSON-LD on /events/[slug] — separate
// from getPublicEvents since it's looked up by slug (not paginated/filtered)
// and intentionally doesn't filter by status/startsAt: a cancelled or past
// event still needs correct <head> tags if a crawler or shared link hits it.
export async function getPublicEventSeo(slug: string): Promise<PublicEventSeo | null> {
  const event = await prisma.event.findUnique({
    where: { slug },
    select: {
      title: true,
      description: true,
      city: true,
      venue: true,
      startsAt: true,
      endsAt: true,
      imageUrl: true,
      currency: true,
      status: true,
      organization: { select: { name: true } },
      ticketTypes: { select: { priceCents: true, quantityTotal: true, quantitySold: true } },
    },
  });
  if (!event) return null;
  const { organization, ...rest } = event;
  return { ...rest, organizerName: organization.name };
}

export interface PlatformStats {
  totalEventsHosted: number;
  totalTicketsSold: number;
  totalCashlessVolumeCents: number;
  currency: string;
}

// Homepage stats. "Cashless volume processed" is completed SALE volume (money
// actually tapped/spent at a vendor) — the same definition summarizeWalletActivity
// already uses for spendVolumeByCurrency elsewhere (vendor/organizer analytics),
// not TOPUP volume (money loaded but not yet spent). Reported in TZS, the
// platform's default/dominant currency — a multi-currency total would mix units.
export async function getPlatformStats(): Promise<PlatformStats> {
  const [totalEventsHosted, ticketAgg, saleTxs] = await Promise.all([
    prisma.event.count({ where: { status: "LIVE" } }),
    prisma.ticketType.aggregate({ _sum: { quantitySold: true } }),
    prisma.walletTransaction.findMany({
      where: { type: "SALE", status: "COMPLETED", currency: DEFAULT_CURRENCY },
      select: { type: true, status: true, amountCents: true, currency: true },
    }),
  ]);

  const { spendVolumeByCurrency } = summarizeWalletActivity(saleTxs);

  return {
    totalEventsHosted,
    totalTicketsSold: ticketAgg._sum.quantitySold ?? 0,
    totalCashlessVolumeCents: spendVolumeByCurrency[DEFAULT_CURRENCY] ?? 0,
    currency: DEFAULT_CURRENCY,
  };
}

export interface SitemapEventEntry {
  slug: string;
  updatedAt: Date;
}

// All published (LIVE) event slugs, for /sitemap.xml — every status other
// than LIVE (i.e. CANCELLED) is excluded, matching "published" in the spec.
export async function getPublishedEventSlugs(): Promise<SitemapEventEntry[]> {
  return prisma.event.findMany({
    where: { status: "LIVE" },
    select: { slug: true, updatedAt: true },
  });
}
