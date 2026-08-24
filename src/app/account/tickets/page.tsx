"use client";

import { useEffect } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { useAppSession } from "@/lib/use-app-session";
import { formatCents, formatDate } from "@/lib/format";

const STATUS_STYLE: Record<string, string> = {
  synced: "border-ok/40 bg-ok/10 text-ok",
  pending: "border-warn/40 bg-warn/10 text-warn",
  conflict: "border-danger/40 bg-danger/10 text-danger",
};

const STATUS_LABEL: Record<string, string> = {
  synced: "Confirmed",
  pending: "Pending sync",
  conflict: "Needs review",
};

export default function MyTicketsPage() {
  const { user, status } = useAppSession();
  const router = useRouter();

  const orders = useLiveQuery(async () => {
    if (!user) return [];
    const all = await db.orders.where("userId").equals(user.id).toArray();
    return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }, [user?.id]);

  useEffect(() => {
    if (status !== "loading" && !user) router.push("/login?callbackUrl=/account/tickets");
  }, [status, user, router]);

  if (!user) return null;

  return (
    <div className="mx-auto max-w-3xl px-4 pb-20 pt-8 sm:px-6">
      <h1 className="mb-6 text-2xl font-bold">My Tickets</h1>

      {orders === undefined ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="card h-24 animate-pulse bg-surface2" />
          ))}
        </div>
      ) : orders.length === 0 ? (
        <div className="card p-10 text-center text-muted">
          No tickets yet. <Link href="/" className="text-accent-hover">Find an event</Link>
        </div>
      ) : (
        <div className="space-y-3">
          {orders.map((order) => (
            <Link
              key={order.id}
              href={`/orders/${order.id}`}
              className="card flex items-center justify-between p-4 transition hover:border-accent"
            >
              <div>
                <p className="font-semibold">{order.eventTitle}</p>
                <p className="text-sm text-muted">
                  {formatDate(order.createdAt)} · {order.tickets.length} ticket
                  {order.tickets.length === 1 ? "" : "s"} · {formatCents(order.totalCents, order.currency)}
                </p>
              </div>
              <span className={`pill ${STATUS_STYLE[order.syncStatus]}`}>
                {STATUS_LABEL[order.syncStatus]}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
