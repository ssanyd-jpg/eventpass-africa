import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { purchaseListing } from "@/lib/resale";

const buySchema = z.object({
  phoneNumber: z.string().min(1),
  mobileNetwork: z.string().optional(),
});

// Buying requires an account (the ticket has to land somewhere), unlike
// browsing the marketplace, which is public. The listing must belong to the
// event in the URL, so a listing id can't be bought through the wrong page.
export async function POST(request: Request, { params }: { params: { slug: string; listingId: string } }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Sign in to buy a ticket." }, { status: 401 });
  }

  const parsed = buySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Enter your mobile money number." }, { status: 400 });
  }

  const listing = await prisma.ticketListing.findUnique({
    where: { id: params.listingId },
    select: { event: { select: { slug: true } } },
  });
  if (!listing || listing.event.slug !== params.slug) {
    return NextResponse.json({ ok: false, error: "Listing not found." }, { status: 404 });
  }

  const result = await purchaseListing(session.user.id, params.listingId, parsed.data);
  if (!result.ok) {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json(result);
}
