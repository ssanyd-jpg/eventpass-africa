import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { formatDateTime } from "@/lib/format";
import { getActiveListingsForEvent, RESALE_COMMISSION_RATE } from "@/lib/resale";
import ResaleListings from "./ResaleListings";

// Never cache: listings appear, sell and expire minute to minute, and the
// "your own listing" state depends on who is looking.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const event = await prisma.event.findUnique({ where: { slug: params.slug }, select: { title: true } });
  return { title: event ? `Resale tickets — ${event.title} — Chaap` : "Event not found — Chaap" };
}

export default async function EventResalePage({ params }: { params: { slug: string } }) {
  const event = await prisma.event.findUnique({
    where: { slug: params.slug },
    select: { id: true, slug: true, title: true, startsAt: true, status: true, resaleEnabled: true },
  });
  if (!event) notFound();

  const session = await auth();
  const resaleOpen = event.resaleEnabled && event.status === "LIVE" && event.startsAt > new Date();
  const listings = resaleOpen ? await getActiveListingsForEvent(event.id, session?.user?.id ?? null) : [];

  return (
    <div className="mx-auto max-w-3xl px-4 pb-20 pt-8 sm:px-6">
      <Link href={`/events/${event.slug}`} className="text-sm text-muted hover:text-foreground">
        ← {event.title}
      </Link>
      <h1 className="mb-1 mt-3 text-2xl font-bold">Resale tickets</h1>
      <p className="mb-6 text-sm text-muted">
        {event.title} · {formatDateTime(event.startsAt)}. Tickets from fans who can no longer go — never priced above face value.
      </p>

      {!resaleOpen ? (
        <div className="card p-10 text-center text-muted">Resale isn&apos;t available for this event.</div>
      ) : (
        <ResaleListings slug={event.slug} listings={listings} signedIn={!!session?.user?.id} />
      )}

      {resaleOpen && (
        <p className="mt-6 text-xs text-muted">
          You pay the asking price shown. Chaap keeps a {RESALE_COMMISSION_RATE * 100}% commission from the seller, not from you.
        </p>
      )}
    </div>
  );
}
