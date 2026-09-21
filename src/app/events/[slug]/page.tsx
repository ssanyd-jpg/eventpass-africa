import type { Metadata } from "next";
import { getPublicEventSeo, computeEventPricing } from "@/lib/marketplace";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { countActiveListings } from "@/lib/resale";
import EventDetailClient from "./EventDetailClient";

// EventDetailClient (the actual buyer-facing page — ticket selection,
// checkout, group buying, etc.) stays exactly as it was: a "use client"
// component reading the event out of Dexie, since that's what makes it
// work offline. It has no server-fetched data and so cannot itself export
// generateMetadata or emit SEO-crawlable content. This file is the new,
// separate server-rendered wrapper Session 25 needs: it does its own
// Prisma lookup by slug purely for <head> metadata and JSON-LD, then
// renders the untouched client page underneath.
const SITE_URL = process.env.NEXTAUTH_URL ?? "https://chaap.africa";

interface EventDetailPageProps {
  params: { slug: string };
}

export async function generateMetadata({ params }: EventDetailPageProps): Promise<Metadata> {
  const event = await getPublicEventSeo(params.slug);
  if (!event) {
    return { title: "Event not found — Chaap" };
  }

  const description = event.description.slice(0, 160);
  const url = `${SITE_URL}/events/${params.slug}`;

  return {
    title: `${event.title} — Chaap`,
    description,
    openGraph: {
      title: event.title,
      description,
      url,
      images: [{ url: event.imageUrl }],
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: event.title,
      description,
      images: [event.imageUrl],
    },
  };
}

export default async function EventDetailPage({ params }: EventDetailPageProps) {
  const event = await getPublicEventSeo(params.slug);

  // Session 32 — "Resale tickets available" link, only when this event has
  // resale switched on AND at least one live listing. Server-side here, since
  // EventDetailClient reads from Dexie and knows nothing about listings.
  const resaleEvent = event
    ? await prisma.event.findUnique({ where: { slug: params.slug }, select: { id: true, resaleEnabled: true } })
    : null;
  const resaleListingCount = resaleEvent?.resaleEnabled ? await countActiveListings(resaleEvent.id) : 0;

  const jsonLd = event
    ? {
        "@context": "https://schema.org",
        "@type": "Event",
        name: event.title,
        description: event.description,
        startDate: event.startsAt.toISOString(),
        ...(event.endsAt ? { endDate: event.endsAt.toISOString() } : {}),
        eventStatus:
          event.status === "CANCELLED"
            ? "https://schema.org/EventCancelled"
            : "https://schema.org/EventScheduled",
        eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
        location: {
          "@type": "Place",
          name: event.venue,
          address: { "@type": "PostalAddress", addressLocality: event.city, addressCountry: "TZ" },
        },
        image: [event.imageUrl],
        organizer: { "@type": "Organization", name: event.organizerName },
        offers: (() => {
          const { lowestPriceCents, soldOut } = computeEventPricing(event.ticketTypes);
          if (lowestPriceCents === null) return undefined;
          return {
            "@type": "Offer",
            url: `${SITE_URL}/events/${params.slug}`,
            price: (lowestPriceCents / 100).toFixed(2),
            priceCurrency: event.currency,
            availability: soldOut ? "https://schema.org/SoldOut" : "https://schema.org/InStock",
          };
        })(),
      }
    : null;

  return (
    <>
      {jsonLd && (
        // eslint-disable-next-line react/no-danger
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      )}
      {resaleListingCount > 0 && (
        <div className="mx-auto max-w-5xl px-4 pt-4 sm:px-6">
          <Link href={`/events/${params.slug}/resale`} className="card flex items-center justify-between p-3 text-sm font-medium text-accent-hover transition hover:border-accent">
            <span>Resale tickets available ({resaleListingCount})</span>
            <span aria-hidden="true">→</span>
          </Link>
        </div>
      )}
      <EventDetailClient />
    </>
  );
}
