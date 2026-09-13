import { prisma } from "@/lib/prisma";
import { buildCsvDocument } from "@/lib/csv";
import { compareCampaigns, type CampaignStats } from "@/lib/sponsor-campaign-analytics";

// Prisma queries behind the sponsor dashboard's campaign-comparison section
// and its CSV export, following sponsor-dashboard-data.ts's exact split —
// extracted for direct testability without going through auth()/NextAuth.
// Scoped strictly by sponsorId (never a separate eventId param): a Sponsor
// already belongs to exactly one Event, so sponsorId alone fully scopes
// every query below — same reasoning getSponsorDashboardData(sponsorId)
// already relies on.
export async function getSponsorCampaignComparison(sponsorId: string): Promise<{
  sponsorName: string;
  // Only true once there are 2+ ACTIVE campaigns — the dashboard section is
  // hidden entirely otherwise, per the spec's own display rule.
  eligible: boolean;
  campaigns: CampaignStats[];
} | null> {
  const sponsor = await prisma.sponsor.findUnique({
    where: { id: sponsorId },
    include: { sponsorCampaigns: { where: { active: true }, select: { id: true, name: true, code: true } } },
  });
  if (!sponsor) return null;

  // Every SPONSOR_TAP at this sponsor's zone across the whole event, not
  // just today — unlike the live "today" stats on the rest of the
  // dashboard, campaign comparison is a whole-campaign performance report
  // (see point 4 of the spec: organisers share it with sponsors
  // POST-event), so it deliberately isn't reset at midnight.
  const taps = await prisma.walletTransaction.findMany({
    where: { sponsorId: sponsor.id, type: "SPONSOR_TAP" },
    select: { walletId: true, campaignId: true, createdAt: true },
  });

  return {
    sponsorName: sponsor.name,
    eligible: sponsor.sponsorCampaigns.length >= 2,
    campaigns: compareCampaigns(sponsor.sponsorCampaigns, taps),
  };
}

export function buildCampaignComparisonCsv(sponsorName: string, campaigns: CampaignStats[]): string {
  return buildCsvDocument([
    {
      title: `Campaign comparison — ${sponsorName}`,
      headers: [
        "Campaign",
        "Code",
        "Total Redemptions",
        "Unique Redeemers",
        "Redemption Rate",
        "Avg. Time To Redeem (min)",
        "Winner",
      ],
      rows: campaigns.map((c) => [
        c.name,
        c.code,
        c.totalRedemptions,
        c.uniqueRedeemers,
        `${(c.redemptionRate * 100).toFixed(1)}%`,
        c.averageTimeToRedeemMinutes ?? "",
        c.isWinner ? "Yes" : "",
      ]),
    },
  ]);
}
