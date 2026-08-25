import { prisma } from "@/lib/prisma";
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
  sponsorTapsByZone,
  TREND_WINDOW_DAYS,
} from "@/lib/analytics";
import BarSeries from "@/components/charts/BarSeries";
import ProgressBar from "@/components/charts/ProgressBar";

// Auth is already enforced by src/app/admin/layout.tsx (role check) plus
// the edge middleware on /admin/:path* — no extra check needed here,
// matching every other page under /admin.
export default async function AdminAnalyticsPage() {
  const windowStart = trendWindowStart();

  const [events, revenueOrders, ticketTypes, tickets, vendors, revenueOrdersWithOrganizer, wallets, walletTxs] = await Promise.all([
    prisma.event.findMany({ select: { id: true, title: true } }),
    prisma.order.findMany({
      where: { status: { in: ["PAID", "NEEDS_REVIEW"] }, createdAt: { gte: windowStart } },
      select: { createdAt: true, totalCents: true, currency: true },
    }),
    prisma.ticketType.findMany({
      select: { id: true, name: true, quantityTotal: true, quantitySold: true, event: { select: { id: true, title: true } } },
    }),
    prisma.ticket.findMany({
      where: { order: { status: { not: "REFUNDED" } } },
      select: { eventId: true, createdAt: true, checkedIn: true },
    }),
    prisma.vendor.findMany({
      select: { status: true, feeStatus: true, stallFeeCents: true, currency: true },
    }),
    prisma.order.findMany({
      where: { status: { in: ["PAID", "NEEDS_REVIEW"] }, createdAt: { gte: windowStart } },
      select: {
        totalCents: true,
        currency: true,
        event: { select: { organizationId: true, organization: { select: { name: true } } } },
      },
    }),
    prisma.wallet.findMany({ select: { balanceCents: true, currency: true } }),
    prisma.walletTransaction.findMany({
      select: { type: true, status: true, amountCents: true, currency: true, sponsorZoneLabel: true, vendor: { select: { id: true, name: true } } },
    }),
  ]);

  const revenueByCurrency = bucketRevenueByDay(revenueOrders);
  const ticketsSoldTrend = bucketByDay(
    tickets.filter((t) => t.createdAt >= windowStart),
    (t) => t.createdAt,
    () => 1
  );
  const checkIns = checkInRateByEvent(tickets, events);
  const sellThrough = ticketTypeSellThrough(ticketTypes).slice(0, 10);
  const vendorStats = summarizeVendors(vendors);
  const revenueCurrencies = Object.keys(revenueByCurrency).sort();
  const topOrganizers = topOrganizersByRevenue(revenueOrdersWithOrganizer);
  const topOrganizerCurrencies = Object.keys(topOrganizers).sort();
  const topEvents = topEventsByTicketsSold(ticketTypes);
  const walletBalanceStats = summarizeWalletBalances(wallets);
  const walletActivityStats = summarizeWalletActivity(walletTxs);
  const vendorSpend = spendByVendor(walletTxs);
  const tapsByZone = sponsorTapsByZone(walletTxs);

  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">Analytics</h1>
      <p className="mb-6 text-sm text-muted">Platform-wide, last {TREND_WINDOW_DAYS} days for trends.</p>

      <h2 className="mb-3 font-semibold">Revenue</h2>
      {revenueCurrencies.length === 0 ? (
        <div className="card p-6 text-center text-sm text-muted">No revenue in the last {TREND_WINDOW_DAYS} days.</div>
      ) : (
        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {revenueCurrencies.map((currency) => {
            const series = revenueByCurrency[currency];
            const total = series.reduce((s, p) => s + p.value, 0);
            return (
              <div key={currency} className="card p-5">
                <p className="text-xs uppercase tracking-wide text-muted">Revenue ({currency})</p>
                <p className="mb-3 mt-1 text-2xl font-bold">{formatCents(total, currency)}</p>
                <BarSeries
                  data={series.map((p) => ({ label: p.date, value: p.value, displayValue: formatCents(p.value, currency) }))}
                  emptyLabel={`No ${currency} revenue in the last ${TREND_WINDOW_DAYS} days.`}
                />
              </div>
            );
          })}
        </div>
      )}

      <h2 className="mb-3 mt-8 font-semibold">Top organizers by revenue</h2>
      {topOrganizerCurrencies.length === 0 ? (
        <div className="card mb-8 p-6 text-center text-sm text-muted">No revenue yet.</div>
      ) : (
        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {topOrganizerCurrencies.map((currency) => (
            <div key={currency} className="card p-5">
              <p className="mb-3 text-xs uppercase tracking-wide text-muted">By {currency}</p>
              <BarSeries
                data={topOrganizers[currency].map((o) => ({ label: o.label, value: o.value, displayValue: formatCents(o.value, currency) }))}
                emptyLabel={`No ${currency} revenue yet.`}
              />
            </div>
          ))}
        </div>
      )}

      <h2 className="mb-3 mt-8 font-semibold">Top events by tickets sold</h2>
      <div className="card mb-8 p-5">
        <BarSeries
          data={topEvents.map((e) => ({ label: e.label, value: e.value, displayValue: `${e.value} sold` }))}
          emptyLabel="No tickets sold yet."
        />
      </div>

      <h2 className="mb-3 mt-8 font-semibold">Tickets sold (platform-wide)</h2>
      <div className="card mb-8 p-5">
        <p className="mb-3 text-2xl font-bold">{ticketsSoldTrend.reduce((s, p) => s + p.value, 0)}</p>
        <BarSeries
          data={ticketsSoldTrend.map((p) => ({ label: p.date, value: p.value, displayValue: `${p.value} sold` }))}
          emptyLabel={`No tickets sold in the last ${TREND_WINDOW_DAYS} days.`}
        />
      </div>

      <h2 className="mb-3 mt-8 font-semibold">Check-in rate</h2>
      <div className="card mb-8 space-y-4 p-5">
        {checkIns.length === 0 ? (
          <p className="text-center text-sm text-muted">No tickets sold yet.</p>
        ) : (
          checkIns.map((c) => (
            <ProgressBar key={c.eventId} label={c.title} pct={c.pct} detail={`${c.checkedIn}/${c.total}`} />
          ))
        )}
      </div>

      <h2 className="mb-3 mt-8 font-semibold">Ticket type performance (top 10)</h2>
      <div className="card mb-8 p-5">
        <BarSeries
          data={sellThrough.map((s) => ({
            label: `${s.name} — ${s.eventTitle}`,
            value: s.pct,
            displayValue: `${s.quantitySold}/${s.quantityTotal} (${s.pct}%)`,
          }))}
          emptyLabel="No ticket sales yet."
        />
      </div>

      <h2 className="mb-3 mt-8 font-semibold">Vendor marketplace</h2>
      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="card p-5">
          <p className="text-xs uppercase tracking-wide text-muted">Applications</p>
          <p className="mt-1 text-2xl font-bold">{vendorStats.applications}</p>
          <p className="mt-1 text-xs text-muted">
            {vendorStats.approved} approved · {vendorStats.pending} pending · {vendorStats.rejected} rejected
          </p>
        </div>
        <div className="card p-5">
          <p className="text-xs uppercase tracking-wide text-muted">Approval rate</p>
          {vendorStats.approvalRatePct === null ? (
            <p className="mt-1 text-2xl font-bold text-muted">—</p>
          ) : (
            <p className="mt-1 text-2xl font-bold">{vendorStats.approvalRatePct}%</p>
          )}
        </div>
        <div className="card p-5">
          <p className="text-xs uppercase tracking-wide text-muted">Fee revenue</p>
          {Object.keys(vendorStats.feeRevenueByCurrency).length === 0 ? (
            <p className="mt-1 text-2xl font-bold text-muted">—</p>
          ) : (
            Object.entries(vendorStats.feeRevenueByCurrency).map(([currency, cents]) => (
              <p key={currency} className="mt-1 text-2xl font-bold">{formatCents(cents, currency)}</p>
            ))
          )}
        </div>
      </div>

      <h2 className="mb-3 mt-8 font-semibold">Cashless wallets</h2>
      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="card p-5">
          <p className="text-xs uppercase tracking-wide text-muted">Top-up volume</p>
          {Object.keys(walletActivityStats.topupVolumeByCurrency).length === 0 ? (
            <p className="mt-1 text-2xl font-bold text-muted">—</p>
          ) : (
            Object.entries(walletActivityStats.topupVolumeByCurrency).map(([currency, cents]) => (
              <p key={currency} className="mt-1 text-2xl font-bold">{formatCents(cents, currency)}</p>
            ))
          )}
        </div>
        <div className="card p-5">
          <p className="text-xs uppercase tracking-wide text-muted">Spend volume</p>
          {Object.keys(walletActivityStats.spendVolumeByCurrency).length === 0 ? (
            <p className="mt-1 text-2xl font-bold text-muted">—</p>
          ) : (
            Object.entries(walletActivityStats.spendVolumeByCurrency).map(([currency, cents]) => (
              <p key={currency} className="mt-1 text-2xl font-bold">{formatCents(cents, currency)}</p>
            ))
          )}
        </div>
        <div className="card p-5">
          <p className="text-xs uppercase tracking-wide text-muted">Outstanding balance</p>
          {Object.keys(walletBalanceStats.outstandingBalanceByCurrency).length === 0 ? (
            <p className="mt-1 text-2xl font-bold text-muted">—</p>
          ) : (
            Object.entries(walletBalanceStats.outstandingBalanceByCurrency).map(([currency, cents]) => (
              <p key={currency} className="mt-1 text-2xl font-bold">{formatCents(cents, currency)}</p>
            ))
          )}
          <p className="mt-1 text-xs text-muted">{walletBalanceStats.walletCount} wallet(s) registered</p>
        </div>
      </div>

      {Object.keys(vendorSpend).length > 0 && (
        <>
          <h3 className="mb-3 mt-6 text-sm font-semibold text-muted">Spend by vendor</h3>
          <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {Object.entries(vendorSpend).map(([currency, entries]) => (
              <div key={currency} className="card p-5">
                <p className="mb-3 text-xs uppercase tracking-wide text-muted">By {currency}</p>
                <BarSeries
                  data={entries.map((e) => ({ label: e.label, value: e.value, displayValue: formatCents(e.value, currency) }))}
                  emptyLabel="No wallet spend yet."
                />
              </div>
            ))}
          </div>
        </>
      )}

      {tapsByZone.length > 0 && (
        <>
          <h3 className="mb-3 mt-6 text-sm font-semibold text-muted">Sponsor zone taps</h3>
          <div className="card mb-8 p-5">
            <BarSeries
              data={tapsByZone.map((e) => ({ label: e.label, value: e.value, displayValue: `${e.value} taps` }))}
              emptyLabel="No sponsor taps yet."
            />
          </div>
        </>
      )}
    </div>
  );
}
