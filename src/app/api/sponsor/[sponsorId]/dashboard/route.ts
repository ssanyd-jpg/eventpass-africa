import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSponsorDashboardData } from "@/lib/sponsor-dashboard-data";

// Polled by the sponsor dashboard page every 60s — same cadence and same
// "the ONLY auth this route accepts is a session whose own id matches the
// route param" discipline as /api/vendor/[vendorId]/dashboard. The actual
// data query lives in getSponsorDashboardData (src/lib/sponsor-dashboard-data.ts),
// split out so it's directly testable without going through auth().
export async function GET(request: Request, { params }: { params: { sponsorId: string } }) {
  const session = await auth();
  if (session?.user?.role !== "SPONSOR" || session.user.sponsorId !== params.sponsorId) {
    return NextResponse.json({ ok: false, reason: "FORBIDDEN" }, { status: 403 });
  }

  const data = await getSponsorDashboardData(params.sponsorId);
  if (!data) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, ...data });
}
