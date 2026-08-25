import { prisma } from "@/lib/prisma";
import { formatDate } from "@/lib/format";

export default async function AdminUsersPage() {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { orders: true } },
      organizationMembership: { include: { organization: { include: { _count: { select: { events: true } } } } } },
    },
  });

  return (
    <div className="card divide-y divide-border">
      {users.map((u) => (
        <div key={u.id} className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm">
          <div>
            <p className="font-medium">
              {u.name}
              {u.role === "ADMIN" && <span className="ml-2 pill border-accent/40 bg-accent-soft text-accent-hover">Admin</span>}
            </p>
            <p className="text-muted">{u.email}</p>
          </div>
          <div className="text-right text-xs text-muted">
            <p>{u.organizationMembership?.organization._count.events ?? 0} events organized · {u._count.orders} orders placed</p>
            <p>Joined {formatDate(u.createdAt)}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
