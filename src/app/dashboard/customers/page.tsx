import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { formatCents, formatDateTime } from "@/lib/format";
import { customerStatsByBuyer } from "@/lib/analytics";
import { getCustomerListData } from "@/lib/analytics-data";

// Server-rendered, non-offline — mirrors dashboard/analytics/page.tsx and
// dashboard/events/[id]/page.tsx: routine day-to-day work (viewing
// purchase history), so OWNER and STAFF can both see it, only GATE_CREW is
// blocked (see src/middleware.ts for the same GATE_CREW-only redirect).
export default async function CustomersPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login?callbackUrl=/dashboard/customers");
  }
  if (session.user.organizationRole === "GATE_CREW") {
    redirect("/dashboard");
  }

  const orders = await getCustomerListData(session.user.organizationId);
  const customers = customerStatsByBuyer(orders);

  return (
    <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 sm:px-6">
      <Link href="/dashboard" className="text-sm text-muted hover:text-foreground">← Dashboard</Link>
      <div className="mb-6 mt-3 flex items-center justify-between gap-4">
        <div>
          <h1 className="mb-1 text-2xl font-bold">Customers</h1>
          <p className="text-sm text-muted">Everyone who has bought a ticket at your events.</p>
        </div>
        <Link href="/dashboard/customers/broadcast" className="btn-secondary shrink-0 text-sm">
          Broadcast
        </Link>
      </div>

      {customers.length === 0 ? (
        <div className="card p-8 text-center text-muted">No customers yet.</div>
      ) : (
        <div className="card divide-y divide-border">
          {customers.map((c) => (
            <Link
              key={c.userId}
              href={`/dashboard/customers/${c.userId}`}
              className="flex items-center justify-between gap-3 p-4 text-sm transition hover:bg-surface2"
            >
              <div>
                <p className="font-medium">{c.name}</p>
                <p className="text-xs text-muted">{c.email}</p>
                <p className="mt-1 text-xs text-muted">Last order {formatDateTime(c.lastOrderAt)}</p>
              </div>
              <div className="text-right">
                <p className="font-medium">
                  {c.ordersCount} order{c.ordersCount === 1 ? "" : "s"}
                </p>
                {Object.entries(c.totalCentsByCurrency).map(([currency, cents]) => (
                  <p key={currency} className="text-xs text-muted">{formatCents(cents, currency)}</p>
                ))}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
