import { prisma } from "@/lib/prisma";
import { formatCents, formatDate } from "@/lib/format";
import { adminSetEventStatus } from "./actions";

export default async function AdminEventsPage() {
  const events = await prisma.event.findMany({
    orderBy: { createdAt: "desc" },
    // Same cap as admin/orders's own findMany — this page has no pagination,
    // so an unbounded query here would only get slower (and the list only
    // longer) as the platform grows.
    take: 200,
    include: {
      organization: {
        select: {
          name: true,
          membership: { where: { role: "OWNER" }, take: 1, select: { user: { select: { email: true } } } },
        },
      },
      _count: { select: { orders: true } },
      ticketTypes: true,
    },
  });

  if (events.length === 0) {
    return <div className="card p-8 text-center text-muted">No events on the platform yet.</div>;
  }

  return (
    <div className="card divide-y divide-border">
      {events.map((e) => {
        const gross = e.ticketTypes.reduce((s, tt) => s + tt.priceCents * tt.quantitySold, 0);
        return (
          <div key={e.id} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
            <div>
              <p className="font-medium">
                {e.title}
                {e.status === "CANCELLED" && (
                  <span className="ml-2 pill border-danger/40 bg-danger/10 text-danger">Cancelled</span>
                )}
              </p>
              <p className="text-muted">
                {e.organization.name}
                {e.organization.membership[0] ? ` (${e.organization.membership[0].user.email})` : ""} · {formatDate(e.startsAt)}
              </p>
              <p className="text-xs text-muted">{e._count.orders} orders · {formatCents(gross, e.currency)} gross</p>
            </div>
            <form
              action={async () => {
                "use server";
                await adminSetEventStatus(e.id, e.status === "CANCELLED" ? "LIVE" : "CANCELLED");
              }}
            >
              <button
                type="submit"
                className={e.status === "CANCELLED" ? "btn-secondary !px-3 !py-1.5 text-xs" : "text-xs font-medium text-danger hover:underline"}
              >
                {e.status === "CANCELLED" ? "Restore" : "Unpublish"}
              </button>
            </form>
          </div>
        );
      })}
    </div>
  );
}
