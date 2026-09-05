import { prisma } from "@/lib/prisma";
import { formatCents, formatDate } from "@/lib/format";

const STATUS_STYLE: Record<string, string> = {
  PAID: "border-ok/40 bg-ok/10 text-ok",
  NEEDS_REVIEW: "border-danger/40 bg-danger/10 text-danger",
  REFUNDED: "border-warn/40 bg-warn/10 text-warn",
  PENDING: "border-warn/40 bg-warn/10 text-warn",
  PAYMENT_FAILED: "border-danger/40 bg-danger/10 text-danger",
};

export default async function AdminOrdersPage() {
  const orders = await prisma.order.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      user: { select: { name: true, email: true } },
      event: { select: { title: true } },
    },
  });

  return (
    <div className="card divide-y divide-border">
      {orders.map((o) => (
        <div key={o.id} className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm">
          <div>
            <p className="font-medium">{o.event.title} — {formatCents(o.totalCents, o.currency)}</p>
            <p className="text-muted">{o.user.name} ({o.user.email}) · {formatDate(o.createdAt)}</p>
          </div>
          <span className={`pill ${STATUS_STYLE[o.status] ?? ""}`}>{o.status}</span>
        </div>
      ))}
      {orders.length === 0 && <p className="p-8 text-center text-muted">No orders yet.</p>}
    </div>
  );
}
