"use client";

import { useEffect, useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { useAppSession } from "@/lib/use-app-session";
import { formatCents, formatDate } from "@/lib/format";

export default function DashboardPage() {
  const { user, status } = useAppSession();
  const router = useRouter();

  const events = useLiveQuery(async () => {
    if (!user) return [];
    const all = await db.events.where("organizationId").equals(user.organizationId).toArray();
    return all.sort((a, b) => (a.startsAt > b.startsAt ? 1 : -1));
  }, [user?.id]);

  const orders = useLiveQuery(async () => {
    if (!user || !events) return [];
    const eventIds = new Set(events.map((e) => e.id));
    const all = await db.orders.toArray();
    return all.filter((o) => eventIds.has(o.eventId));
  }, [user?.id, events]);

  useEffect(() => {
    if (status !== "loading" && !user) router.push("/login?callbackUrl=/dashboard");
  }, [status, user, router]);

  const stats = useMemo(() => {
    if (!orders) return { revenueByCurrency: {} as Record<string, number>, ticketsSold: 0, pending: 0 };
    const revenueByCurrency: Record<string, number> = {};
    let ticketsSold = 0;
    let pending = 0;
    for (const o of orders) {
      revenueByCurrency[o.currency] = (revenueByCurrency[o.currency] ?? 0) + o.totalCents;
      ticketsSold += o.tickets.length;
      if (o.syncStatus === "pending") pending += 1;
    }
    return { revenueByCurrency, ticketsSold, pending };
  }, [orders]);

  if (!user) return null;

  return (
    <div className="mx-auto max-w-6xl px-4 pb-20 pt-8 sm:px-6">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{user.organizationName ?? "Organizer Dashboard"}</h1>
          <p className="text-sm text-muted">{user.name}</p>
        </div>
        <div className="flex gap-2">
          <Link href="/dashboard/analytics" className="btn-secondary">Analytics</Link>
          <Link href="/dashboard/settlements" className="btn-secondary">Settlements</Link>
          <Link href="/dashboard/events/new" className="btn-primary">+ Create Event</Link>
        </div>
      </div>

      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <RevenueStatCard revenueByCurrency={stats.revenueByCurrency} />
        <StatCard label="Tickets sold" value={String(stats.ticketsSold)} />
        <StatCard
          label="Pending sync"
          value={String(stats.pending)}
          accent={stats.pending > 0 ? "warn" : undefined}
        />
      </div>

      <h2 className="mb-4 font-semibold">Your events</h2>
      {events === undefined ? (
        <div className="card h-24 animate-pulse bg-surface2" />
      ) : events.length === 0 ? (
        <div className="card p-10 text-center text-muted">
          You haven&apos;t created any events yet.
          <div className="mt-4">
            <Link href="/dashboard/events/new" className="btn-primary">Create your first event</Link>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {events.map((event) => {
            const sold = event.ticketTypes.reduce((s, tt) => s + tt.quantitySold, 0);
            const capacity = event.ticketTypes.reduce((s, tt) => s + tt.quantityTotal, 0);
            return (
              <div key={event.id} className="card flex flex-wrap items-center justify-between gap-3 p-4">
                <div>
                  <p className="font-semibold">
                    {event.title}
                    {event.syncStatus === "pending" && (
                      <span className="ml-2 pill border-warn/40 bg-warn/10 text-warn">Pending sync</span>
                    )}
                  </p>
                  <p className="text-sm text-muted">
                    {formatDate(event.startsAt)} · {sold}/{capacity} sold
                  </p>
                </div>
                <div className="flex gap-2">
                  <Link href={`/dashboard/events/${event.id}`} className="btn-secondary !px-3 !py-1.5 text-xs">
                    Manage
                  </Link>
                  <Link href={`/scan/${event.id}`} className="btn-primary !px-3 !py-1.5 text-xs">
                    Scan gate
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: "warn" }) {
  return (
    <div className="card p-5">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${accent === "warn" ? "text-warn" : ""}`}>{value}</p>
    </div>
  );
}

// An organizer can run events in more than one currency — summing their
// totals into one number would be meaningless, so each currency gets its
// own line instead.
function RevenueStatCard({ revenueByCurrency }: { revenueByCurrency: Record<string, number> }) {
  const entries = Object.entries(revenueByCurrency);
  return (
    <div className="card p-5">
      <p className="text-xs uppercase tracking-wide text-muted">Total revenue</p>
      {entries.length === 0 ? (
        <p className="mt-1 text-2xl font-bold">{formatCents(0)}</p>
      ) : (
        <div className={entries.length > 1 ? "mt-1 space-y-0.5" : ""}>
          {entries.map(([currency, cents]) => (
            <p key={currency} className={entries.length > 1 ? "text-lg font-bold" : "mt-1 text-2xl font-bold"}>
              {formatCents(cents, currency)}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
