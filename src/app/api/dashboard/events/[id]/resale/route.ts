import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

// Page data for /dashboard/events/[id]/resale. Same access rule as the
// waitlist data route: any org member except GATE_CREW, then the event must
// belong to the caller's organisation.
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, reason: "UNAUTHENTICATED" }, { status: 401 });
  }
  if (session.user.organizationRole === "GATE_CREW") {
    return NextResponse.json({ ok: false, reason: "FORBIDDEN" }, { status: 403 });
  }

  const event = await prisma.event.findUnique({
    where: { id: params.id },
    select: { id: true, title: true, organizationId: true, currency: true, resaleEnabled: true, maxResalePrice: true },
  });
  if (!event || event.organizationId !== session.user.organizationId) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  const listings = await prisma.ticketListing.groupBy({
    by: ["status"],
    where: { eventId: event.id },
    _count: { _all: true },
  });

  return NextResponse.json({
    ok: true,
    eventTitle: event.title,
    currency: event.currency,
    resaleEnabled: event.resaleEnabled,
    maxResalePrice: event.maxResalePrice,
    listingCounts: Object.fromEntries(listings.map((l) => [l.status, l._count._all])),
  });
}
