import { prisma } from "@/lib/prisma";
import { formatCents, formatDate } from "@/lib/format";

export default async function AdminSettlementsPage() {
  const settlements = await prisma.settlement.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      organization: {
        select: {
          name: true,
          membership: { where: { role: "OWNER" }, take: 1, select: { user: { select: { email: true } } } },
        },
      },
      mobileMoneyAccount: true,
    },
  });

  // Settlements span every organization on the platform, who can each run
  // events in different currencies — totals are grouped per currency
  // rather than summed into one meaningless number.
  const totalsByCurrency: Record<string, { net: number; fees: number }> = {};
  for (const s of settlements) {
    const bucket = totalsByCurrency[s.currency] ?? { net: 0, fees: 0 };
    bucket.net += s.netCents;
    bucket.fees += s.platformFeeCents;
    totalsByCurrency[s.currency] = bucket;
  }
  const currencyTotals = Object.entries(totalsByCurrency);

  return (
    <div>
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="card p-5">
          <p className="text-xs uppercase tracking-wide text-muted">Total paid out</p>
          {currencyTotals.length === 0 ? (
            <p className="mt-1 text-2xl font-bold">{formatCents(0)}</p>
          ) : (
            currencyTotals.map(([currency, t]) => (
              <p key={currency} className="mt-1 text-2xl font-bold">{formatCents(t.net, currency)}</p>
            ))
          )}
        </div>
        <div className="card p-5">
          <p className="text-xs uppercase tracking-wide text-muted">Total platform fees</p>
          {currencyTotals.length === 0 ? (
            <p className="mt-1 text-2xl font-bold">{formatCents(0)}</p>
          ) : (
            currencyTotals.map(([currency, t]) => (
              <p key={currency} className="mt-1 text-2xl font-bold">{formatCents(t.fees, currency)}</p>
            ))
          )}
        </div>
      </div>

      <div className="card divide-y divide-border">
        {settlements.map((s) => (
          <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm">
            <div>
              <p className="font-medium">
                {s.organization.name}
                {s.organization.membership[0] ? ` (${s.organization.membership[0].user.email})` : ""}
              </p>
              <p className="text-muted">
                {formatDate(s.createdAt)} · {s.mobileMoneyAccount.provider} · {s.payoutReference}
              </p>
            </div>
            <p className="font-semibold">{formatCents(s.netCents, s.currency)} net</p>
          </div>
        ))}
        {settlements.length === 0 && <p className="p-8 text-center text-muted">No settlements yet.</p>}
      </div>
    </div>
  );
}
