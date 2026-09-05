"use client";

import { useEffect } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { useAppSession } from "@/lib/use-app-session";
import { formatCents, formatDateTime } from "@/lib/format";

const STATUS_STYLE: Record<string, string> = {
  PENDING: "pill border-warn/40 bg-warn/10 text-warn",
  PAYMENT_FAILED: "pill border-danger/40 bg-danger/10 text-danger",
};
const STATUS_LABEL: Record<string, string> = {
  PENDING: "Awaiting payment",
  PAYMENT_FAILED: "Payment failed",
};

// Cross-event, org-wide — mirrors dashboard/withdrawals's top-level
// placement (a single sweep queue across every event, rather than digging
// through each event's own Attendees page one at a time). Read-only for
// now: the per-event Attendees page (dashboard/events/[id]/page.tsx) is
// where an organizer actually acts on an order (e.g. refund); this page is
// for spotting which orders need that attention in the first place,
// including OFFLINE_DEFERRED orders that were never a problem, just
// unreconciled cash/mobile-money collected in person.
export default function PaymentsPage() {
  const router = useRouter();
  const { user } = useAppSession();

  // Middleware already redirects GATE_CREW away from this route server-side
  // — this is defense-in-depth for a device offline with an already-cached
  // page shell (see src/middleware.ts).
  useEffect(() => {
    if (user?.organizationRole === "GATE_CREW") router.replace("/dashboard");
  }, [user, router]);

  const myEventIds = useLiveQuery(async () => {
    if (!user) return new Set<string>();
    const events = await db.events.where("organizationId").equals(user.organizationId).toArray();
    return new Set(events.map((e) => e.id));
  }, [user?.organizationId], new Set<string>());

  const orders = useLiveQuery(async () => {
    if (!myEventIds || myEventIds.size === 0) return [];
    const all = await db.orders.toArray();
    return all
      .filter(
        (o) =>
          myEventIds.has(o.eventId) &&
          (o.status === "PENDING" || o.status === "PAYMENT_FAILED" || o.paymentMethod === "OFFLINE_DEFERRED")
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }, [myEventIds]);

  if (user?.organizationRole === "GATE_CREW") return null;

  return (
    <div className="mx-auto max-w-3xl px-4 pb-20 pt-8 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold">Payments</h1>
      <p className="mb-6 text-sm text-muted">
        Orders awaiting mobile money confirmation, that failed to pay, or
        that were collected offline and need reconciliation. Refund or
        review an individual order from its event&apos;s Attendees page.
      </p>

      {orders === undefined ? (
        <div className="card p-8 text-center text-muted">Loading…</div>
      ) : orders.length === 0 ? (
        <div className="card p-8 text-center text-muted">Nothing needs attention right now.</div>
      ) : (
        <div className="card divide-y divide-border">
          {orders.map((order) => (
            <Link
              key={order.id}
              href={`/dashboard/events/${order.eventId}`}
              className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm hover:bg-surface2"
            >
              <div>
                <p className="font-medium">{order.eventTitle} — {formatCents(order.totalCents, order.currency)}</p>
                <p className="text-muted">{formatDateTime(order.createdAt)}</p>
              </div>
              <div className="flex items-center gap-2">
                {STATUS_STYLE[order.status] && (
                  <span className={STATUS_STYLE[order.status]}>{STATUS_LABEL[order.status]}</span>
                )}
                {order.paymentMethod === "OFFLINE_DEFERRED" && <span className="pill">Offline</span>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
