import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { formatCents } from "@/lib/format";
import {
  trendWindowStart,
  bucketRevenueByDay,
  bucketByDay,
  checkInRateByEvent,
  ticketTypeSellThrough,
  summarizeVendors,
  summarizeWalletBalances,
  summarizeWalletActivity,
  spendByVendor,
  sponsorTapsBySponsor,
} from "@/lib/analytics";
import { getOrganizerAnalyticsData } from "@/lib/analytics-data";
import { buildCsvDocument, centsToMajorUnits, type CsvSection } from "@/lib/csv";

// A full (un-truncated) export of the organizer analytics dashboard's own
// figures. Bypasses the dashboard's top-5/top-10 display truncation on
// spendByVendor/sponsorTapsBySponsor via a large limit override — those
// truncations are a chart-legibility choice, not a data limit.
const EXPORT_LIMIT = 10000;

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, reason: "UNAUTHENTICATED" }, { status: 401 });
  }
  // Mirrors the analytics page's own access rule (src/app/dashboard/analytics/page.tsx):
  // block GATE_CREW only. STAFF can already view this dashboard on-screen, so
  // this deliberately does NOT use the stricter OWNER-only pattern from
  // settlements/run or organization/invite — those gate money-moving
  // actions, not read access to data STAFF already sees.
  if (session.user.organizationRole === "GATE_CREW") {
    return NextResponse.json({ ok: false, reason: "FORBIDDEN" }, { status: 403 });
  }

  const { myEvents, revenueOrders, ticketTypes, tickets, vendors, wallets, walletTxs } =
    await getOrganizerAnalyticsData(session.user.organizationId);

  const windowStart = trendWindowStart();
  const revenueByCurrency = bucketRevenueByDay(revenueOrders);
  const ticketsSoldTrend = bucketByDay(
    tickets.filter((t) => t.createdAt >= windowStart),
    (t) => t.createdAt,
    () => 1
  );
  const checkIns = checkInRateByEvent(tickets, myEvents);
  const sellThrough = ticketTypeSellThrough(ticketTypes);
  const vendorStats = summarizeVendors(vendors);
  const walletBalanceStats = summarizeWalletBalances(wallets);
  const walletActivityStats = summarizeWalletActivity(walletTxs);
  const vendorSpend = spendByVendor(walletTxs, EXPORT_LIMIT);
  const tapsBySponsor = sponsorTapsBySponsor(walletTxs, EXPORT_LIMIT);

  const sections: CsvSection[] = [
    {
      title: "Revenue by day",
      headers: ["Date", "Currency", "Amount (Major Units)", "Amount (Formatted)"],
      rows: Object.keys(revenueByCurrency)
        .sort()
        .flatMap((currency) =>
          revenueByCurrency[currency].map((p) => [p.date, currency, centsToMajorUnits(p.value), formatCents(p.value, currency)])
        ),
    },
    {
      title: "Tickets sold trend",
      headers: ["Date", "Tickets Sold"],
      rows: ticketsSoldTrend.map((p) => [p.date, p.value]),
    },
    {
      title: "Check-in rate by event",
      headers: ["Event", "Checked In", "Total", "Percent"],
      rows: checkIns.map((c) => [c.title, c.checkedIn, c.total, c.pct]),
    },
    {
      title: "Ticket type performance",
      headers: ["Event", "Ticket Type", "Sold", "Total", "Percent"],
      rows: sellThrough.map((s) => [s.eventTitle, s.name, s.quantitySold, s.quantityTotal, s.pct]),
    },
    {
      title: "Vendor marketplace",
      headers: ["Metric", "Value"],
      rows: [
        ["Applications", vendorStats.applications],
        ["Approved", vendorStats.approved],
        ["Pending", vendorStats.pending],
        ["Rejected", vendorStats.rejected],
        ["Approval Rate (%)", vendorStats.approvalRatePct],
        ...Object.entries(vendorStats.feeRevenueByCurrency).flatMap(([currency, cents]) => [
          [`Fee Revenue (${currency}, Major Units)`, centsToMajorUnits(cents)],
          [`Fee Revenue (${currency}, Formatted)`, formatCents(cents, currency)],
        ]),
      ],
    },
    {
      title: "Cashless wallets",
      headers: ["Metric", "Currency", "Amount (Major Units)", "Amount (Formatted)"],
      rows: [
        ...Object.entries(walletActivityStats.topupVolumeByCurrency).map(([currency, cents]) => [
          "Top-up volume",
          currency,
          centsToMajorUnits(cents),
          formatCents(cents, currency),
        ]),
        ...Object.entries(walletActivityStats.spendVolumeByCurrency).map(([currency, cents]) => [
          "Spend volume",
          currency,
          centsToMajorUnits(cents),
          formatCents(cents, currency),
        ]),
        ...Object.entries(walletBalanceStats.outstandingBalanceByCurrency).map(([currency, cents]) => [
          "Outstanding balance",
          currency,
          centsToMajorUnits(cents),
          formatCents(cents, currency),
        ]),
        ["Wallet Count", "", walletBalanceStats.walletCount, ""],
      ],
    },
    {
      title: "Spend by vendor",
      headers: ["Currency", "Vendor", "Amount (Major Units)", "Amount (Formatted)"],
      rows: Object.entries(vendorSpend).flatMap(([currency, entries]) =>
        entries.map((e) => [currency, e.label, centsToMajorUnits(e.value), formatCents(e.value, currency)])
      ),
    },
    {
      title: "Sponsor taps by sponsor",
      headers: ["Sponsor", "Taps"],
      rows: tapsBySponsor.map((e) => [e.label, e.value]),
    },
  ];

  const csv = buildCsvDocument(sections);
  const filename = `chaap-analytics-${new Date().toISOString().slice(0, 10)}.csv`;

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
