import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSponsorCampaignComparison, buildCampaignComparisonCsv } from "@/lib/sponsor-campaign-analytics-data";
import { slugify } from "@/lib/format";

// Mirrors the sponsor-leads export route's exact shape (see
// /api/dashboard/events/[id]/sponsors/[sponsorId]/leads/export), but
// session-gated the same way as the sponsor dashboard's own poll route
// above it — a SPONSOR session whose sponsorId matches the route param,
// never an organiser session (this file lives in the sponsor portal, not
// the organiser dashboard).
export async function GET(request: Request, { params }: { params: { sponsorId: string } }) {
  const session = await auth();
  if (session?.user?.role !== "SPONSOR" || session.user.sponsorId !== params.sponsorId) {
    return NextResponse.json({ ok: false, reason: "FORBIDDEN" }, { status: 403 });
  }

  const comparison = await getSponsorCampaignComparison(params.sponsorId);
  if (!comparison) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  const csv = buildCampaignComparisonCsv(comparison.sponsorName, comparison.campaigns);
  const filename = `campaign-comparison-${slugify(comparison.sponsorName)}.csv`;

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
