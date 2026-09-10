"use client";

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { db, newLocalId } from "@/lib/db";
import { queueOp } from "@/lib/sync-engine";
import { useAppSession } from "@/lib/use-app-session";
import { formatCents, formatDateTime, formatDate } from "@/lib/format";
import { predictSellOut, forecastEventRevenue, type SellOutStatus } from "@/lib/forecast";
import { detectOrderAnomalies } from "@/lib/anomaly";
import { scoreOrderRisk, type RiskBand } from "@/lib/risk";
import BarSeries from "@/components/charts/BarSeries";

// Deterministic, not Claude-backed — see forecast.ts's header comment.
const SELL_OUT_PILL: Record<SellOutStatus, string> = {
  SOLD_OUT: "",
  LIKELY: "pill border-warn/40 bg-warn/10 text-warn",
  ON_TRACK: "pill border-ok/40 bg-ok/10 text-ok",
  SLOW: "",
  INSUFFICIENT_DATA: "",
};

// Deterministic, not Claude-backed — see anomaly.ts/risk.ts. LOW renders no
// badge at all, matching this codebase's "only show a pill when something's
// notable" convention (e.g. the pending-sync badge only appears when true).
const RISK_STYLE: Record<RiskBand, string> = {
  LOW: "",
  MEDIUM: "pill border-warn/40 bg-warn/10 text-warn",
  HIGH: "pill border-danger/40 bg-danger/10 text-danger",
};

// Mirrors admin/orders/page.tsx's STATUS_STYLE convention — only shown for
// a status worth flagging; PAID renders no pill (the default, unremarkable
// case), matching RISK_STYLE's own "only show when notable" discipline.
const ORDER_STATUS_STYLE: Record<string, string> = {
  NEEDS_REVIEW: "pill border-danger/40 bg-danger/10 text-danger",
  REFUNDED: "pill border-danger/40 bg-danger/10 text-danger",
  PENDING: "pill border-warn/40 bg-warn/10 text-warn",
  PAYMENT_FAILED: "pill border-danger/40 bg-danger/10 text-danger",
  CANCELLED: "pill",
};
const ORDER_STATUS_LABEL: Record<string, string> = {
  NEEDS_REVIEW: "Review",
  REFUNDED: "Refunded",
  PENDING: "Awaiting payment",
  PAYMENT_FAILED: "Payment failed",
  CANCELLED: "Cancelled by buyer",
};

export default function ManageEventPage() {
  const { id: rawId } = useParams<{ id: string }>();
  const id = decodeURIComponent(rawId);
  const router = useRouter();
  const { user } = useAppSession();
  const [refunding, setRefunding] = useState<string | null>(null);
  const [refundError, setRefundError] = useState<string | null>(null);
  const [markingPaid, setMarkingPaid] = useState<string | null>(null);

  // Middleware already redirects GATE_CREW away from this route server-side
  // — this is defense-in-depth for a device offline with an already-cached
  // page shell (see src/middleware.ts).
  useEffect(() => {
    if (user?.organizationRole === "GATE_CREW") router.replace("/dashboard");
  }, [user, router]);

  const event = useLiveQuery(async () => {
    const byId = await db.events.get(id);
    return byId ?? (await db.events.where("clientId").equals(id).first()) ?? null;
  }, [id]);

  const orders = useLiveQuery(async () => {
    if (!event) return [];
    const all = await db.orders.where("eventId").equals(event.id).toArray();
    return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }, [event?.id]);

  const vendors = useLiveQuery(async () => {
    if (!event) return [];
    return db.vendors.where("eventId").equals(event.id).toArray();
  }, [event?.id]);

  if (user?.organizationRole === "GATE_CREW") return null;

  if (event === undefined) {
    return <div className="mx-auto max-w-4xl px-4 py-16 text-center text-muted">Loading…</div>;
  }

  if (!event) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-16 text-center">
        <p className="font-semibold">Event not found on this device.</p>
        <Link href="/dashboard" className="btn-secondary mt-6 inline-flex">Back to dashboard</Link>
      </div>
    );
  }

  // Allowlist, not an exclusion list — a still-PENDING (unpaid) or
  // PAYMENT_FAILED order isn't real revenue/attendance yet, same reasoning
  // as the REFUNDED exclusion this already had. NEEDS_REVIEW stays counted
  // — pre-existing, unrelated oversell-review behavior.
  const activeOrders = (orders ?? []).filter((o) => o.status === "PAID" || o.status === "NEEDS_REVIEW");
  const tickets = activeOrders.flatMap((o) => o.tickets);
  const checkedInCount = tickets.filter((t) => t.checkedIn).length;

  // Sell-out predictions and revenue forecast — deterministic heuristics
  // computed client-side from the already-synced orders/ticket types this
  // page loads anyway (no new fetch). See forecast.ts.
  const sellOutPredictions = event
    ? event.ticketTypes.map((tt) => {
        const items = activeOrders.flatMap((o) =>
          o.items.filter((i) => i.ticketTypeId === tt.id).map((i) => ({ createdAt: new Date(o.createdAt), quantity: i.quantity }))
        );
        return predictSellOut(tt, items, new Date(event.startsAt));
      })
    : [];

  const revenueForecast = event
    ? forecastEventRevenue(
        activeOrders.map((o) => ({ createdAt: new Date(o.createdAt), totalCents: o.totalCents })),
        new Date(event.startsAt),
        new Date(),
        (cents) => formatCents(cents, event.currency)
      )
    : [];

  // Anomaly flags + risk scores — deterministic, computed over EVERY order
  // for this event including REFUNDED ones (refund-rate is one of the
  // signals, so filtering those out first would blind that signal
  // entirely). See anomaly.ts/risk.ts.
  const anomalyRows = (orders ?? []).map((o) => ({
    id: o.id,
    userId: o.userId,
    userCreatedAt: o.userCreatedAt,
    status: o.status,
    discountCode: o.discountCode ?? null,
    createdAt: o.createdAt,
    ticketCount: o.tickets.length,
    eventId: event?.id ?? "",
  }));
  const orderAnomalies = detectOrderAnomalies(anomalyRows);
  const anomaliesByOrderId = new Map<string, string[]>();
  for (const flag of orderAnomalies) {
    anomaliesByOrderId.set(flag.relatedId, [...(anomaliesByOrderId.get(flag.relatedId) ?? []), flag.message]);
  }
  const riskByOrderId = new Map(anomalyRows.map((row) => [row.id, scoreOrderRisk(row, { allOrders: anomalyRows })]));

  // Likely-abandoned Airpay STK pushes — the buyer's phone prompt expired
  // or they never saw it, but the poll/webhook never resolved it either.
  // Keyed off updatedAt (falls back to createdAt for a not-yet-synced local
  // echo that has no updatedAt yet) rather than createdAt alone, since a
  // resolved-then-somehow-reopened order shouldn't count from its original
  // creation time. 10 minutes is deliberately well past Airpay's own STK
  // prompt timeout (~60-120s in practice) — this is for orders the normal
  // flow has already given up on, not ones still genuinely in flight.
  const TEN_MINUTES_MS = 10 * 60 * 1000;
  const stuckPendingOrders = (orders ?? []).filter(
    (o) => o.status === "PENDING" && Date.now() - new Date(o.updatedAt ?? o.createdAt).getTime() > TEN_MINUTES_MS
  );

  async function markOrderPaid(order: NonNullable<typeof orders>[number]) {
    setMarkingPaid(order.id);
    try {
      // No inventory change — PENDING already reserved it at checkout time.
      await db.orders.put({ ...order, status: "PAID", syncStatus: "pending" });
      await queueOp("MARK_ORDER_PAID", {
        clientId: newLocalId(),
        orderId: order.id,
        orderClientId: order.clientId,
      });
    } finally {
      setMarkingPaid(null);
    }
  }

  async function refundOrder(order: NonNullable<typeof orders>[number]) {
    setRefundError(null);
    setRefunding(order.id);
    try {
      await db.orders.put({ ...order, status: "REFUNDED", syncStatus: "pending" });
      for (const item of order.items) {
        const tt = event!.ticketTypes.find((t) => t.id === item.ticketTypeId);
        if (tt) {
          await db.events.put({
            ...event!,
            ticketTypes: event!.ticketTypes.map((t) =>
              t.id === tt.id ? { ...t, quantitySold: Math.max(0, t.quantitySold - item.quantity) } : t
            ),
          });
        }
      }
      await queueOp("REFUND_ORDER", {
        clientId: newLocalId(),
        orderId: order.id,
        orderClientId: order.clientId,
      });
    } finally {
      setRefunding(null);
    }
  }

  async function cancelEvent() {
    // Session 9: warn if cash operators still have unreconciled floats.
    // Best-effort — a failed/offline check never blocks cancellation, it
    // just falls through to the normal confirm.
    try {
      const res = await fetch(`/api/dashboard/events/${event!.id}/reconciliation`, { cache: "no-store" });
      const body = await res.json();
      if (body.ok && body.unreconciledOperatorCount > 0) {
        const n = body.unreconciledOperatorCount;
        if (
          !confirm(
            `${n} cash ${n === 1 ? "operator has" : "operators have"} not been reconciled — reconcile before closing?\n\nOK to cancel the event anyway, or Cancel to go reconcile first.`
          )
        ) {
          return;
        }
      }
    } catch {
      // ignore — proceed to the normal confirm below
    }
    if (!confirm(`Cancel "${event!.title}"? Ticket holders will be notified. This cannot be undone.`)) return;
    await db.events.put({ ...event!, status: "CANCELLED", syncStatus: "pending" });
    await queueOp("CANCEL_EVENT", { eventId: event!.id, eventClientId: event!.clientId });
  }

  return (
    <div className="mx-auto max-w-4xl px-4 pb-20 pt-8 sm:px-6">
      <Link href="/dashboard" className="text-sm text-muted hover:text-foreground">← Dashboard</Link>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">
            {event.title}
            {event.status === "CANCELLED" && (
              <span className="ml-2 pill border-danger/40 bg-danger/10 text-danger">Cancelled</span>
            )}
          </h1>
          <p className="text-sm text-muted">{formatDateTime(event.startsAt)} · {event.venue}, {event.city}</p>
        </div>
        <div className="flex gap-2">
          <Link href={`/dashboard/events/${event.id}/edit`} className="btn-secondary">Edit</Link>
          <Link href={`/dashboard/events/${event.id}/vendors`} className="btn-secondary">Vendors</Link>
          <Link href={`/dashboard/events/${event.id}/sponsors`} className="btn-secondary">Sponsors</Link>
          <Link href={`/dashboard/events/${event.id}/live`} target="_blank" rel="noopener noreferrer" className="btn-secondary">
            Live monitoring ↗
          </Link>
          <Link href={`/scan/${event.id}/provision`} target="_blank" rel="noopener noreferrer" className="btn-secondary">
            Wristband desk ↗
          </Link>
          <Link href={`/scan/${event.id}/replace`} target="_blank" rel="noopener noreferrer" className="btn-secondary">
            Wristband replacement ↗
          </Link>
          <Link href={`/dashboard/events/${event.id}/reconciliation`} className="btn-secondary">
            Reconciliation ↗
          </Link>
          <Link href={`/scan/${event.id}/wallet`} className="btn-secondary">Wallets</Link>
          <Link href={`/scan/${event.id}`} className="btn-primary">Scan gate</Link>
        </div>
      </div>

      {event.status !== "CANCELLED" && (
        <button onClick={cancelEvent} className="mt-3 text-xs font-medium text-danger hover:underline">
          Cancel this event
        </button>
      )}

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="card p-5">
          <p className="text-xs uppercase tracking-wide text-muted">Tickets sold</p>
          <p className="mt-1 text-2xl font-bold">{tickets.length}</p>
        </div>
        <div className="card p-5">
          <p className="text-xs uppercase tracking-wide text-muted">Checked in</p>
          <p className="mt-1 text-2xl font-bold">{checkedInCount} / {tickets.length}</p>
        </div>
        <div className="card p-5">
          <p className="text-xs uppercase tracking-wide text-muted">Gross revenue</p>
          <p className="mt-1 text-2xl font-bold">
            {formatCents(activeOrders.reduce((s, o) => s + o.totalCents, 0), event.currency)}
          </p>
        </div>
        <div className="card p-5">
          <p className="text-xs uppercase tracking-wide text-muted">Vendors</p>
          <p className="mt-1 text-2xl font-bold">
            {(vendors ?? []).filter((v) => v.status === "APPROVED").length}
            <span className="text-base font-normal text-muted"> approved</span>
          </p>
        </div>
      </div>

      <h2 className="mb-3 mt-8 font-semibold">Ticket types</h2>
      <div className="card divide-y divide-border">
        {event.ticketTypes.map((tt) => {
          const prediction = sellOutPredictions.find((p) => p.ticketTypeId === tt.id);
          return (
            <div key={tt.id} className="flex items-center justify-between p-4">
              <div>
                <p className="font-medium">{tt.name}</p>
                <p className="text-sm text-muted">{formatCents(tt.priceCents, event.currency)} each</p>
              </div>
              <div className="text-right text-sm">
                <p>
                  <span className="font-semibold">{tt.quantitySold}</span>
                  <span className="text-muted"> / {tt.quantityTotal} sold</span>
                  {tt.quantitySold > tt.quantityTotal && (
                    <span className="ml-2 pill border-danger/40 bg-danger/10 text-danger">Oversold</span>
                  )}
                </p>
                {prediction?.status === "LIKELY" && prediction.predictedSoldOutDate && (
                  <p className="mt-1">
                    <span className={SELL_OUT_PILL.LIKELY}>Likely to sell out {formatDate(prediction.predictedSoldOutDate)}</span>
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {revenueForecast.length > 0 && (
        <>
          <h2 className="mb-3 mt-8 font-semibold">Revenue trend</h2>
          <div className="card p-5">
            <BarSeries data={revenueForecast} emptyLabel="No sales yet." />
            {revenueForecast.some((p) => p.projected) && (
              <p className="mt-3 text-xs text-muted">Lighter bars are a projection based on recent sales pace, not actual revenue.</p>
            )}
          </div>
        </>
      )}

      {stuckPendingOrders.length > 0 && (
        <>
          <h2 className="mb-3 mt-8 font-semibold">Pending payments needing follow-up</h2>
          <div className="card divide-y divide-border">
            {stuckPendingOrders.map((order) => {
              const minutesPending = Math.floor(
                (Date.now() - new Date(order.updatedAt ?? order.createdAt).getTime()) / 60000
              );
              return (
                <div key={order.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                  <div>
                    <p className="font-medium">{formatCents(order.totalCents, order.currency)}</p>
                    <p className="text-xs text-muted">
                      {order.items.map((i) => `${i.quantity}× ${i.ticketTypeName}`).join(", ")}
                    </p>
                    <p className="mt-1 text-xs text-warn">
                      Pending {minutesPending}m{order.providerReference ? ` · Ref: ${order.providerReference}` : ""}
                    </p>
                  </div>
                  <button
                    onClick={() => markOrderPaid(order)}
                    disabled={markingPaid === order.id}
                    className="btn-secondary !py-1.5 text-xs disabled:opacity-50"
                  >
                    {markingPaid === order.id ? "Marking…" : "Mark as paid"}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}

      <h2 className="mb-3 mt-8 font-semibold">Attendees</h2>
      {refundError && <p className="mb-3 text-sm text-danger">{refundError}</p>}
      {(orders ?? []).length === 0 ? (
        <div className="card p-8 text-center text-muted">No tickets sold yet.</div>
      ) : (
        <div className="card divide-y divide-border">
          {(orders ?? []).map((order) => (
            <div key={order.id} className="p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{formatCents(order.totalCents, event.currency)}</span>
                  <span className="text-muted">
                    {order.tickets.map((t) => t.code).join(", ")}
                  </span>
                  {order.syncStatus === "pending" && (
                    <span className="pill border-warn/40 bg-warn/10 text-warn">Pending sync</span>
                  )}
                  {ORDER_STATUS_STYLE[order.status] && (
                    <span className={ORDER_STATUS_STYLE[order.status]}>{ORDER_STATUS_LABEL[order.status]}</span>
                  )}
                  {order.paymentMethod === "OFFLINE_DEFERRED" && (
                    <span className="pill">Offline</span>
                  )}
                  {(() => {
                    const risk = riskByOrderId.get(order.id);
                    if (!risk || risk.band === "LOW") return null;
                    return (
                      <span className={RISK_STYLE[risk.band]} title={(anomaliesByOrderId.get(order.id) ?? risk.reasons).join("; ")}>
                        Risk: {risk.band.toLowerCase()}
                      </span>
                    );
                  })()}
                </div>
                {(order.status === "PAID" || order.status === "NEEDS_REVIEW") && (
                  <button
                    onClick={() => refundOrder(order)}
                    disabled={refunding === order.id}
                    className="text-xs font-medium text-danger hover:underline disabled:opacity-50"
                  >
                    {refunding === order.id ? "Refunding…" : "Refund"}
                  </button>
                )}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                {order.tickets.map((t) => (
                  <span key={t.id}>
                    {t.ticketTypeName} — {t.checkedIn ? "checked in" : "not yet"}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
