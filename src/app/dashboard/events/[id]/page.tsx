"use client";

import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams } from "next/navigation";
import Link from "next/link";
import { db, newLocalId } from "@/lib/db";
import { queueOp } from "@/lib/sync-engine";
import { formatCents, formatDateTime } from "@/lib/format";

export default function ManageEventPage() {
  const { id: rawId } = useParams<{ id: string }>();
  const id = decodeURIComponent(rawId);
  const [refunding, setRefunding] = useState<string | null>(null);
  const [refundError, setRefundError] = useState<string | null>(null);

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

  const activeOrders = (orders ?? []).filter((o) => o.status !== "REFUNDED");
  const tickets = activeOrders.flatMap((o) => o.tickets);
  const checkedInCount = tickets.filter((t) => t.checkedIn).length;

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
        {event.ticketTypes.map((tt) => (
          <div key={tt.id} className="flex items-center justify-between p-4">
            <div>
              <p className="font-medium">{tt.name}</p>
              <p className="text-sm text-muted">{formatCents(tt.priceCents, event.currency)} each</p>
            </div>
            <p className="text-sm">
              <span className="font-semibold">{tt.quantitySold}</span>
              <span className="text-muted"> / {tt.quantityTotal} sold</span>
              {tt.quantitySold > tt.quantityTotal && (
                <span className="ml-2 pill border-danger/40 bg-danger/10 text-danger">Oversold</span>
              )}
            </p>
          </div>
        ))}
      </div>

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
                  {order.status === "NEEDS_REVIEW" && (
                    <span className="pill border-danger/40 bg-danger/10 text-danger">Review</span>
                  )}
                  {order.status === "REFUNDED" && (
                    <span className="pill border-danger/40 bg-danger/10 text-danger">Refunded</span>
                  )}
                </div>
                {order.status !== "REFUNDED" && (
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
