import { NextResponse } from "next/server";
import { getPublicMarathonResults } from "@/lib/marathon-results-data";

// Public, unauthenticated JSON for /events/[slug]/results — same
// no-session-check posture as the public leaderboard route: a printable
// race-day results page anyone can view, never anything an order/account
// page would (email, phone, ticket price).
export async function GET(_request: Request, { params }: { params: { slug: string } }) {
  const data = await getPublicMarathonResults(params.slug);
  if (!data) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, ...data }, { headers: { "Cache-Control": "no-store" } });
}
