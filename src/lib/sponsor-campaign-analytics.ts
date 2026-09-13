// Pure, DB-free campaign-comparison analytics (Session 17) — same
// testability convention as revenue-forecast.ts/analytics.ts: no Prisma, no
// fetch, plain inputs in, plain numbers out. The spec named these functions
// compareCampaigns(sponsorId, eventId) / timeToRedeem(sponsorId, campaignId,
// eventId), but a DB-free function can't take ids alone — the actual
// Prisma lookups live in sponsor-campaign-analytics-data.ts (which fetches
// by sponsorId, per that file's own header comment), and these two take the
// already-fetched rows instead, exactly like revenue-forecast.ts's own
// computeScenario/summarizeHistoricalPerformance never take ids either.

// One row per SPONSOR_TAP at this sponsor's zone — a plain zone tap has
// campaignId null; a campaign redemption has it set to the campaign
// redeemed. Mirrors WalletTransaction's own shape (see handleSponsorTap in
// sync-handlers.ts) rather than inventing a separate "redemption" row type,
// since this schema has no SponsorCampaignRedemption model — every
// redemption already IS one of these rows.
export interface CampaignTapRecord {
  walletId: string;
  campaignId: string | null;
  createdAt: Date;
}

export interface CampaignInput {
  id: string;
  name: string;
  code: string;
}

export interface CampaignStats {
  id: string;
  name: string;
  code: string;
  totalRedemptions: number;
  uniqueRedeemers: number;
  // uniqueRedeemers / total unique zone visitors (every distinct wallet that
  // ever tapped this sponsor's zone, redeemed or not) — 0 when the zone has
  // had no visitors at all, never divides by zero.
  redemptionRate: number;
  averageTimeToRedeemMinutes: number | null;
  // This campaign's own redemptionRate as a fraction of the best campaign's
  // rate (1 for the winner, 0 when nobody has redeemed anything) — feeds the
  // dashboard's relative-performance bar width directly.
  relativePerformance: number;
  isWinner: boolean;
}

// Average minutes between an attendee's FIRST tap at this sponsor's zone
// (their arrival — a plain lead-capture tap or an immediate redemption,
// whichever came first) and the moment they redeemed this specific
// campaign. An attendee whose only tap already was the redemption gets 0
// minutes, not excluded — they redeemed instantly on arrival. Attendees who
// never redeemed this campaign don't contribute a data point at all.
export function timeToRedeem(taps: CampaignTapRecord[], campaignId: string): number | null {
  const byWallet = new Map<string, CampaignTapRecord[]>();
  for (const t of taps) {
    const arr = byWallet.get(t.walletId) ?? [];
    arr.push(t);
    byWallet.set(t.walletId, arr);
  }

  const minutes: number[] = [];
  for (const walletTaps of Array.from(byWallet.values())) {
    const redemption = walletTaps.find((t) => t.campaignId === campaignId);
    if (!redemption) continue;
    const firstTapMs = Math.min(...walletTaps.map((t) => t.createdAt.getTime()));
    minutes.push(Math.max(0, (redemption.createdAt.getTime() - firstTapMs) / 60000));
  }

  if (minutes.length === 0) return null;
  return Math.round(minutes.reduce((sum, m) => sum + m, 0) / minutes.length);
}

// campaigns should already be filtered to this sponsor's ACTIVE campaigns
// for this event (the data fetcher does this) — taps should be every
// SPONSOR_TAP at this sponsor's zone, campaign-redeeming or not, since a
// plain zone tap still counts toward the "total unique visitors" the
// redemption rate divides by.
export function compareCampaigns(campaigns: CampaignInput[], taps: CampaignTapRecord[]): CampaignStats[] {
  const totalUniqueVisitors = new Set(taps.map((t) => t.walletId)).size;

  const withoutRelative = campaigns.map((c) => {
    const redemptions = taps.filter((t) => t.campaignId === c.id);
    const uniqueRedeemers = new Set(redemptions.map((t) => t.walletId)).size;
    const redemptionRate = totalUniqueVisitors > 0 ? uniqueRedeemers / totalUniqueVisitors : 0;
    return {
      id: c.id,
      name: c.name,
      code: c.code,
      totalRedemptions: redemptions.length,
      uniqueRedeemers,
      redemptionRate,
      averageTimeToRedeemMinutes: timeToRedeem(taps, c.id),
    };
  });

  const bestRate = Math.max(0, ...withoutRelative.map((s) => s.redemptionRate));

  // A tie for the best rate shows every tied campaign as a winner rather
  // than arbitrarily picking one — safer than a silent, order-dependent
  // "first one wins" that would misrepresent an actual tie.
  return withoutRelative.map((s) => ({
    ...s,
    relativePerformance: bestRate > 0 ? s.redemptionRate / bestRate : 0,
    isWinner: bestRate > 0 && s.redemptionRate === bestRate,
  }));
}
