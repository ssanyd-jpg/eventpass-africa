"use client";

import { useEffect, useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { useAppSession } from "@/lib/use-app-session";
import { formatCents, formatDate } from "@/lib/format";
import { eventHasEnded } from "@/lib/carry-over";
import { SkeletonList } from "@/components/Skeleton";

const STATUS_STYLE: Record<"LIVE" | "ENDED" | "CANCELLED", string> = {
  LIVE: "pill border-ok/40 bg-ok/10 text-ok",
  ENDED: "pill",
  CANCELLED: "pill border-danger/40 bg-danger/10 text-danger",
};
const STATUS_LABEL: Record<"LIVE" | "ENDED" | "CANCELLED", string> = {
  LIVE: "Live",
  ENDED: "Ended",
  CANCELLED: "Cancelled",
};

// Event.status in the schema is only ever LIVE | CANCELLED (see
// prisma/schema.prisma) — there's no separate DRAFT/PUBLISHED state, every
// event is published the moment it's created. "Ended" is derived the same
// way carry-over eligibility is (eventHasEnded), since a past LIVE event
// reads very differently on a dashboard than an upcoming one.
function eventDisplayStatus(event: { status: string; startsAt: string; endsAt?: string | null }): "LIVE" | "ENDED" | "CANCELLED" {
  if (event.status === "CANCELLED") return "CANCELLED";
  return eventHasEnded(event) ? "ENDED" : "LIVE";
}

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

  // Cashless (wristband) sales volume per event, for the event cards below
  // — a wallet SALE is a vendor purchase tapped against a topped-up
  // wristband, separate from ticket revenue in `orders`.
  const wallets = useLiveQuery(async () => {
    if (!events || events.length === 0) return [];
    const eventIds = new Set(events.map((e) => e.id));
    const all = await db.wallets.toArray();
    return all.filter((w) => eventIds.has(w.eventId));
  }, [events]);

  const walletTransactions = useLiveQuery(async () => {
    if (!wallets || wallets.length === 0) return [];
    const walletIds = new Set(wallets.map((w) => w.id));
    const all = await db.walletTransactions.where("type").equals("SALE").toArray();
    return all.filter((t) => t.status === "COMPLETED" && walletIds.has(t.walletId));
  }, [wallets]);

  const payoutAccounts = useLiveQuery(async () => {
    if (!user) return [];
    return db.mobileMoneyAccounts.where("organizationId").equals(user.organizationId).toArray();
  }, [user?.organizationId]);

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

  // "vs last event" trend — the two most recently-started events in this
  // org, compared against each other. Only meaningful with ≥2 events and
  // matching currencies (mixing currencies into one % change is meaningless).
  const trend = useMemo(() => {
    if (!events || events.length < 2 || !orders) return null;
    const sorted = [...events].sort((a, b) => (a.startsAt < b.startsAt ? 1 : -1));
    const [latest, previous] = sorted;
    if (latest.currency !== previous.currency) return null;
    const forEvent = (eventId: string) => {
      const evOrders = orders.filter((o) => o.eventId === eventId);
      return {
        revenueCents: evOrders.reduce((s, o) => s + o.totalCents, 0),
        tickets: evOrders.reduce((s, o) => s + o.tickets.length, 0),
      };
    };
    const latestStats = forEvent(latest.id);
    const previousStats = forEvent(previous.id);
    const pctChange = (curr: number, prev: number) => (prev === 0 ? null : ((curr - prev) / prev) * 100);
    return {
      eventTitle: latest.title,
      revenuePct: pctChange(latestStats.revenueCents, previousStats.revenueCents),
      ticketsPct: pctChange(latestStats.tickets, previousStats.tickets),
    };
  }, [events, orders]);

  const cashlessByEvent = useMemo(() => {
    const walletToEvent = new Map((wallets ?? []).map((w) => [w.id, w.eventId]));
    const totals = new Map<string, number>();
    for (const t of walletTransactions ?? []) {
      if (t.amountCents == null) continue;
      const eventId = walletToEvent.get(t.walletId);
      if (!eventId) continue;
      totals.set(eventId, (totals.get(eventId) ?? 0) + t.amountCents);
    }
    return totals;
  }, [wallets, walletTransactions]);

  if (!user) return null;

  const isGateCrew = user.organizationRole === "GATE_CREW";
  const loading = events === undefined || orders === undefined;
  const hasNoEvents = events !== undefined && events.length === 0;
  const hasPayoutAccount = (payoutAccounts?.length ?? 0) > 0;

  return (
    <div className="mx-auto max-w-6xl px-4 pb-20 pt-8 sm:px-6">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{user.organizationName ?? "Organizer Dashboard"}</h1>
          <p className="text-sm text-muted">{user.name}</p>
        </div>
      </div>

      {!isGateCrew && (
        <div className="mb-8 grid grid-cols-2 gap-3 sm:flex sm:flex-wrap">
          <Link href="/dashboard/events/new" className="btn-primary">+ Create event</Link>
          <Link
            href={events && events.length > 0 ? `/dashboard/events/${events[events.length - 1].id}/live` : "#"}
            aria-disabled={!events || events.length === 0}
            className={`btn-secondary ${!events || events.length === 0 ? "pointer-events-none opacity-40" : ""}`}
          >
            View live monitoring
          </Link>
          <a href="/api/dashboard/analytics/export" className="btn-secondary">Export data</a>
        </div>
      )}

      {!isGateCrew && (
        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <RevenueStatCard revenueByCurrency={stats.revenueByCurrency} trendPct={trend?.revenuePct ?? null} />
          <StatCard label="Tickets sold" value={String(stats.ticketsSold)} trendPct={trend?.ticketsPct ?? null} />
          <StatCard
            label="Pending sync"
            value={String(stats.pending)}
            accent={stats.pending > 0 ? "warn" : undefined}
          />
        </div>
      )}

      {!isGateCrew && hasNoEvents && (
        <GettingStartedChecklist hasEvent={false} hasPayoutAccount={hasPayoutAccount} />
      )}

      <h2 className="mb-4 font-semibold">Your events</h2>
      {loading ? (
        <SkeletonList rows={2} />
      ) : events.length === 0 ? (
        <div className="card flex flex-col items-center gap-2 p-10 text-center text-muted">
          <span aria-hidden className="mb-1 text-4xl">🎫</span>
          {isGateCrew ? (
            "No events to scan yet."
          ) : (
            <>
              You haven&apos;t created any events yet.
              <div className="mt-3">
                <Link href="/dashboard/events/new" className="btn-primary">Create your first event</Link>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {events.map((event) => {
            const sold = event.ticketTypes.reduce((s, tt) => s + tt.quantitySold, 0);
            const capacity = event.ticketTypes.reduce((s, tt) => s + tt.quantityTotal, 0);
            const pct = capacity > 0 ? Math.min(100, Math.round((sold / capacity) * 100)) : 0;
            const displayStatus = eventDisplayStatus(event);
            const cashlessCents = cashlessByEvent.get(event.id) ?? 0;
            return (
              <div key={event.id} className="card flex flex-col overflow-hidden">
                <div className="relative h-32 w-full bg-surface2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={event.imageUrl} alt="" className="h-full w-full object-cover" />
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-3 pt-6">
                    <p className="truncate font-semibold text-white">{event.title}</p>
                  </div>
                  <div className="absolute right-2 top-2 flex gap-1.5">
                    <span className={STATUS_STYLE[displayStatus]}>{STATUS_LABEL[displayStatus]}</span>
                    {event.syncStatus === "pending" && (
                      <span className="pill border-warn/40 bg-warn/10 text-warn">Pending sync</span>
                    )}
                  </div>
                </div>

                <div className="flex flex-1 flex-col gap-3 p-4">
                  <p className="text-sm text-muted">{formatDate(event.startsAt)}</p>

                  <div>
                    <div className="mb-1 flex items-center justify-between text-xs text-muted">
                      <span>{sold}/{capacity} tickets sold</span>
                      <span className="tabular-nums">{pct}%</span>
                    </div>
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${pct}%` }} />
                    </div>
                  </div>

                  {cashlessCents > 0 && (
                    <p className="text-xs text-muted">
                      Cashless volume: <span className="font-medium text-foreground">{formatCents(cashlessCents, event.currency)}</span>
                    </p>
                  )}

                  <div className="mt-auto flex gap-2 pt-1">
                    {!isGateCrew && (
                      <Link href={`/dashboard/events/${event.id}`} className="btn-secondary flex-1 !px-3 !py-1.5 text-xs">
                        Manage
                      </Link>
                    )}
                    <Link href={`/scan/${event.id}`} className="btn-primary flex-1 !px-3 !py-1.5 text-xs">
                      Scan gate
                    </Link>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TrendArrow({ pct }: { pct: number | null }) {
  if (pct === null || Math.abs(pct) < 0.5) return null;
  const up = pct > 0;
  return (
    <span className={`ml-1.5 inline-flex items-center gap-0.5 text-xs font-medium ${up ? "text-ok" : "text-danger"}`}>
      {up ? "▲" : "▼"} {Math.abs(Math.round(pct))}%
    </span>
  );
}

function StatCard({
  label,
  value,
  accent,
  trendPct,
}: {
  label: string;
  value: string;
  accent?: "warn";
  trendPct?: number | null;
}) {
  return (
    <div className="card p-5">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 flex items-baseline text-2xl font-bold ${accent === "warn" ? "text-warn" : ""}`}>
        {value}
        <TrendArrow pct={trendPct ?? null} />
      </p>
      {trendPct !== undefined && trendPct !== null && Math.abs(trendPct) >= 0.5 && (
        <p className="mt-0.5 text-xs text-muted">vs last event</p>
      )}
    </div>
  );
}

// An organizer can run events in more than one currency — summing their
// totals into one number would be meaningless, so each currency gets its
// own line instead.
function RevenueStatCard({
  revenueByCurrency,
  trendPct,
}: {
  revenueByCurrency: Record<string, number>;
  trendPct: number | null;
}) {
  const entries = Object.entries(revenueByCurrency);
  return (
    <div className="card p-5">
      <p className="text-xs uppercase tracking-wide text-muted">Total revenue</p>
      {entries.length === 0 ? (
        <p className="mt-1 text-2xl font-bold">{formatCents(0)}</p>
      ) : (
        <div className={entries.length > 1 ? "mt-1 space-y-0.5" : ""}>
          {entries.map(([currency, cents]) => (
            <p key={currency} className={`flex items-baseline ${entries.length > 1 ? "text-lg font-bold" : "mt-1 text-2xl font-bold"}`}>
              {formatCents(cents, currency)}
              <TrendArrow pct={trendPct} />
            </p>
          ))}
        </div>
      )}
      {trendPct !== null && Math.abs(trendPct) >= 0.5 && <p className="mt-0.5 text-xs text-muted">vs last event</p>}
    </div>
  );
}

function GettingStartedChecklist({
  hasEvent,
  hasPayoutAccount,
}: {
  hasEvent: boolean;
  hasPayoutAccount: boolean;
}) {
  return (
    <div className="card mb-8 p-5">
      <p className="mb-1 font-semibold">Getting started</p>
      <p className="mb-4 text-sm text-muted">A few steps to get your first event selling tickets.</p>
      <ul className="space-y-2.5">
        <ChecklistItem done={hasEvent} href="/dashboard/events/new">Create your first event</ChecklistItem>
        <ChecklistItem done={hasPayoutAccount} href="/dashboard/settlements">
          Add a mobile money payout account
        </ChecklistItem>
        <ChecklistItem href="/dashboard/team">Invite your team (optional)</ChecklistItem>
      </ul>
    </div>
  );
}

function ChecklistItem({
  done,
  href,
  children,
}: {
  done?: boolean;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <li>
      <Link href={href} className="flex items-center gap-2.5 text-sm transition hover:text-accent-hover">
        <span
          aria-hidden
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs ${
            done ? "border-ok bg-ok/10 text-ok" : "border-border text-transparent"
          }`}
        >
          ✓
        </span>
        <span className={done ? "text-muted line-through" : ""}>{children}</span>
      </Link>
    </li>
  );
}
