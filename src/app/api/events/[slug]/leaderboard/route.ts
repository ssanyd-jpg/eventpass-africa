import { NextResponse } from "next/server";
import { getLeaderboardData } from "@/lib/timing-data";

// Public, unauthenticated — polled every 30s by /events/[slug]/leaderboard.
// No session check at all, deliberately: a race-day results board is meant
// to be shared with anyone (spectators, family tracking a runner), not
// gated behind an account. Only ever returns name/bib/time/pace, never
// anything an order/account page would (email, phone, ticket price).
export async function GET(request: Request, { params }: { params: { slug: string } }) {
  const ticketTypeId = new URL(request.url).searchParams.get("ticketTypeId") ?? undefined;

  const data = await getLeaderboardData(params.slug, ticketTypeId);
  if (!data) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, ...data }, { headers: { "Cache-Control": "no-store" } });
}
