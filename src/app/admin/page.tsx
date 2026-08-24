import Link from "next/link";
import { prisma } from "@/lib/prisma";

export default async function AdminOverviewPage() {
  const [userCount, eventCount, orderCount, unreadLogs] = await Promise.all([
    prisma.user.count(),
    prisma.event.count(),
    prisma.order.count(),
    prisma.notificationLog.count({ where: { status: "LOGGED" } }),
  ]);

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <Stat label="Users" value={userCount} href="/admin/users" />
      <Stat label="Events" value={eventCount} href="/admin/events" />
      <Stat label="Orders" value={orderCount} href="/admin/orders" />
      <Stat label="Unrelayed notifications" value={unreadLogs} href="/admin/notifications" accent={unreadLogs > 0} />
    </div>
  );
}

function Stat({ label, value, href, accent }: { label: string; value: number; href: string; accent?: boolean }) {
  return (
    <Link href={href} className="card p-5 transition hover:border-accent">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${accent ? "text-warn" : ""}`}>{value}</p>
    </Link>
  );
}
