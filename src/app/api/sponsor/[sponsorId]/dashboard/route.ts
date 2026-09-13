import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSponsorDashboardData } from "@/lib/sponsor-dashboard-data";
import { getSponsorCampaignComparison } from "@/lib/sponsor-campaign-analytics-data";

// Polled by the sponsor dashboard page every 60s — same cadence and same
// "the ONLY auth this route accepts is a session whose own id matches the
// route param" discipline as /api/vendor/[vendorId]/dashboard. The actual
// data query lives in getSponsorDashboardData (src/lib/sponsor-dashboard-data.ts),
// split out so it's directly testable without going through auth().
//
// Session 17 — campaignComparison is fetched alongside the existing
// dashboard data and merged into the same polled response rather than a
// second endpoint, so the campaign-comparison section refreshes on the
// dashboard's existing 60s cadence for free. null when the sponsor has
// fewer than 2 active campaigns (see getSponsorCampaignComparison's
// `eligible` flag) — the page hides the section entirely in that case.
export async function GET(request: Request, { params }: { params: { sponsorId: string } }) {
  const session = await auth();
  if (session?.user?.role !== "SPONSOR" || session.user.sponsorId !== params.sponsorId) {
    return NextResponse.json({ ok: false, reason: "FORBIDDEN" }, { status: 403 });
  }

  const data = await getSponsorDashboardData(params.sponsorId);
  if (!data) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  const comparison = await getSponsorCampaignComparison(params.sponsorId);
  const campaignComparison = comparison?.eligible ? comparison.campaigns : null;

  return NextResponse.json({ ok: true, ...data, campaignComparison });
}
