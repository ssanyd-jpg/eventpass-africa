import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { cancelListing } from "@/lib/resale";

// Cancel a listing. Only its seller can — cancelListing enforces that.
export async function DELETE(_request: Request, { params }: { params: { listingId: string } }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 });
  }
  const result = await cancelListing(session.user.id, params.listingId);
  if (!result.ok) {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json(result);
}
