import { prisma } from "@/lib/prisma";
import { formatCents, formatDate } from "@/lib/format";
import { adminSetEventStatus } from "./actions";

export default async function AdminEventsPage() {
  const events = await prisma.event.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      organizer: { select: { name: true, email: true } },
      _count: { select: { orders: true } },
      ticketTypes: true,
    },
  });

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
                {e.organizer.name} ({e.organizer.email}) · {formatDate(e.startsAt)}
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
