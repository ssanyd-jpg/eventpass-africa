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
  topOrganizersByRevenue,
  topEventsByTicketsSold,
  summarizeWalletBalances,
  summarizeWalletActivity,
  spendByVendor,
  sponsorTapsBySponsor,
} from "@/lib/analytics";
import { getPlatformAnalyticsData } from "@/lib/analytics-data";
import { buildCsvDocument, centsToMajorUnits, type CsvSection } from "@/lib/csv";

// A full (un-truncated) export of the platform-wide admin analytics
// dashboard's figures — including ticket type performance beyond the
// on-screen top-10, and every organizer/event beyond the on-screen top-5.
const EXPORT_LIMIT = 10000;

// First route under /api/admin/ — src/middleware.ts's matcher does not
// cover /api/*, and layouts don't run for route handlers, so this inline
// check is the sole enforcement (mirrors src/app/admin/events/actions.ts).
export async function GET() {
  const session = await auth();
  if (session?.user?.role !== "ADMIN") {
    return NextResponse.json({ ok: false, reason: "FORBIDDEN" }, { status: 403 });
  }

  const { events, revenueOrders, ticketTypes, tickets, vendors, revenueOrdersWithOrganizer, wallets, walletTxs } =
    await getPlatformAnalyticsData();

  const windowStart = trendWindowStart();
  const revenueByCurrency = bucketRevenueByDay(revenueOrders);
  const ticketsSoldTrend = bucketByDay(
    tickets.filter((t) => t.createdAt >= windowStart),
    (t) => t.createdAt,
    () => 1
  );
  const checkIns = checkInRateByEvent(tickets, events);
  const sellThrough = ticketTypeSellThrough(ticketTypes);
  const vendorStats = summarizeVendors(vendors);
  const topOrganizers = topOrganizersByRevenue(revenueOrdersWithOrganizer, EXPORT_LIMIT);
  const topEvents = topEventsByTicketsSold(ticketTypes, EXPORT_LIMIT);
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
      title: "Top organizers by revenue",
      headers: ["Currency", "Organizer", "Amount (Major Units)", "Amount (Formatted)"],
      rows: Object.entries(topOrganizers).flatMap(([currency, entries]) =>
        entries.map((e) => [currency, e.label, centsToMajorUnits(e.value), formatCents(e.value, currency)])
      ),
    },
    {
      title: "Top events by tickets sold",
      headers: ["Event", "Tickets Sold"],
      rows: topEvents.map((e) => [e.label, e.value]),
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
  const filename = `eventpass-platform-analytics-${new Date().toISOString().slice(0, 10)}.csv`;

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
