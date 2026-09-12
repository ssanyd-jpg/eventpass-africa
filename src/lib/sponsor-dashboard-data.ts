import { prisma } from "@/lib/prisma";
import { sponsorTapsByHour } from "@/lib/analytics";

// Split out of the route handler so it's directly testable without going
// through auth()/NextAuth request plumbing — same reasoning
// getVendorDashboardData (src/lib/vendor-dashboard-data.ts) is split from
// its own route. Everything here is already scoped to the ONE sponsorId
// passed in; the caller (the API route) is responsible for verifying the
// requesting session is actually allowed to see that sponsorId first.
export async function getSponsorDashboardData(sponsorId: string, now: Date = new Date()) {
  const sponsor = await prisma.sponsor.findUnique({
    where: { id: sponsorId },
    include: {
      event: { select: { title: true } },
      sponsorCampaigns: { select: { id: true, name: true, redemptionCount: true } },
    },
  });
  if (!sponsor) return null;

  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const todaysTaps = await prisma.walletTransaction.findMany({
    where: { sponsorId: sponsor.id, type: "SPONSOR_TAP", createdAt: { gte: todayStart } },
    select: { id: true, createdAt: true, walletId: true, wallet: { select: { code: true } } },
    orderBy: { createdAt: "desc" },
  });

  const totalTapsToday = todaysTaps.length;

  const tapTimesByWallet = new Map<string, Date[]>();
  for (const t of todaysTaps) {
    const arr = tapTimesByWallet.get(t.walletId) ?? [];
    arr.push(t.createdAt);
    tapTimesByWallet.set(t.walletId, arr);
  }
  const uniqueAttendeesToday = tapTimesByWallet.size;

  // Average dwell time — only across attendees who tapped MORE THAN ONCE
  // today; a single tap has no "time between" to measure, and counting it
  // as a zero-minute dwell would understate genuine multi-tap dwell times.
  const dwellDurationsMs: number[] = [];
  for (const times of Array.from(tapTimesByWallet.values())) {
    if (times.length < 2) continue;
    const sortedMs = times.map((d) => d.getTime()).sort((a, b) => a - b);
    dwellDurationsMs.push(sortedMs[sortedMs.length - 1] - sortedMs[0]);
  }
  const averageDwellMinutes =
    dwellDurationsMs.length > 0
      ? Math.round(dwellDurationsMs.reduce((sum, ms) => sum + ms, 0) / dwellDurationsMs.length / 60000)
      : null;

  const tapsByHour = sponsorTapsByHour(todaysTaps, todayStart, now);

  // Cost-per-visit is a whole-event ROI figure — the sponsorship fee is a
  // one-time cost, not a daily one — so it deliberately uses ALL-TIME
  // unique attendees, not just today's, unlike every other stat on this
  // dashboard (which is intentionally today-only for live, in-the-moment
  // monitoring at the booth).
  const allTimeTaps = await prisma.walletTransaction.findMany({
    where: { sponsorId: sponsor.id, type: "SPONSOR_TAP" },
    select: { walletId: true },
    distinct: ["walletId"],
  });
  const uniqueAttendeesAllTime = allTimeTaps.length;
  const costPerVisitCents = uniqueAttendeesAllTime > 0 ? Math.round(sponsor.feeCents / uniqueAttendeesAllTime) : null;

  return {
    // Sponsor has no separate "zone" field (see the schema's own header
    // comment) — the sponsor's own name IS its booth/zone identity, same as
    // how the vendor dashboard headlines vendor.name directly.
    sponsorName: sponsor.name,
    eventTitle: sponsor.event.title,
    currency: sponsor.currency,
    lastUpdated: now.toISOString(),
    stats: {
      totalTapsToday,
      uniqueAttendeesToday,
      averageDwellMinutes,
      costPerVisitCents,
    },
    tapsByHour,
    campaignBreakdown: sponsor.sponsorCampaigns.map((c) => ({
      id: c.id,
      name: c.name,
      redemptions: c.redemptionCount,
    })),
    recentActivity: todaysTaps.slice(0, 20).map((t) => ({
      id: t.id,
      createdAt: t.createdAt.toISOString(),
      maskedCode: `•••${t.wallet.code.slice(-4)}`,
    })),
  };
}
