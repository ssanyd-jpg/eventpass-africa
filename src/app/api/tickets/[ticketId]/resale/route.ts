import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { createListing } from "@/lib/resale";

// askingPrice is minor units (cents), like every other price in the app.
// Validated against face value / the organiser's cap inside createListing —
// the client's own max on the input is a convenience, never the enforcement.
const listSchema = z.object({ askingPrice: z.number().int() });

// Plain authenticated route, not a queueOp/sync mutation — same reasoning as
// /api/tickets/transfer: listing a ticket is an inherently online action that
// needs to report success/failure synchronously.
export async function POST(request: Request, { params }: { params: { ticketId: string } }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Sign in to list a ticket." }, { status: 401 });
  }

  const parsed = listSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Enter a valid price." }, { status: 400 });
  }

  const result = await createListing(session.user.id, params.ticketId, parsed.data.askingPrice);
  if (!result.ok) {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json(result);
}
