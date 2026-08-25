"use client";

import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { db, newLocalId, type LocalOrder } from "@/lib/db";
import { queueOp } from "@/lib/sync-engine";
import { useAppSession } from "@/lib/use-app-session";
import { formatCents, formatDateTime, generateTicketCode } from "@/lib/format";
import OrderConfirmation from "@/components/OrderConfirmation";

export default function EventDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const { user } = useAppSession();
  const events = useLiveQuery(() => db.events.toArray(), []);
  const event = events?.find((e) => e.slug === slug);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [step, setStep] = useState<"select" | "confirm">("select");
  const [placing, setPlacing] = useState(false);
  const [placedOrder, setPlacedOrder] = useState<LocalOrder | null>(null);

  const selection = useMemo(() => {
    if (!event) return [];
    return event.ticketTypes
      .map((tt) => ({ tt, qty: quantities[tt.id] ?? 0 }))
      .filter((s) => s.qty > 0);
  }, [event, quantities]);

  const totalCents = selection.reduce((sum, s) => sum + s.tt.priceCents * s.qty, 0);
  const totalQty = selection.reduce((sum, s) => sum + s.qty, 0);

  if (placedOrder) {
    return <OrderConfirmation order={placedOrder} />;
  }

  if (events === undefined) {
    return <div className="mx-auto max-w-4xl px-4 py-16 text-center text-muted">Loading…</div>;
  }

  if (!event) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-16 text-center">
        <p className="text-lg font-semibold">Event not found on this device.</p>
        <p className="mt-2 text-sm text-muted">
          It may not have synced here yet. Connect once and try again.
        </p>
        <Link href="/" className="btn-secondary mt-6 inline-flex">Back to browse</Link>
      </div>
    );
  }

  function setQty(ticketTypeId: string, qty: number, max: number) {
    setQuantities((q) => ({ ...q, [ticketTypeId]: Math.max(0, Math.min(qty, max)) }));
  }

  async function placeOrder() {
    if (!event || event.status === "CANCELLED") return;
    if (!user) {
      router.push(`/login?callbackUrl=/events/${slug}`);
      return;
    }
    setPlacing(true);

    const clientId = newLocalId();
    const tickets = selection.flatMap((s) =>
      Array.from({ length: s.qty }).map(() => ({
        id: newLocalId(),
        clientId: newLocalId(),
        code: generateTicketCode(),
        ticketTypeId: s.tt.id,
        ticketTypeName: s.tt.name,
        checkedIn: false,
        checkedInAt: null,
      }))
    );

    const order: LocalOrder = {
      id: clientId,
      clientId,
      status: "PAID",
      totalCents,
      currency: event.currency,
      createdAt: new Date().toISOString(),
      userId: user.id,
      eventId: event.id,
      eventClientId: event.clientId,
      eventTitle: event.title,
      items: selection.map((s) => ({
        ticketTypeId: s.tt.id,
        ticketTypeName: s.tt.name,
        quantity: s.qty,
        unitPriceCents: s.tt.priceCents,
      })),
      tickets,
      syncStatus: "pending",
    };

    await db.orders.put(order);

    // reflect the sale locally right away so inventory looks correct offline
    await db.events.put({
      ...event,
      ticketTypes: event.ticketTypes.map((tt) => {
        const sold = selection.find((s) => s.tt.id === tt.id);
        return sold ? { ...tt, quantitySold: tt.quantitySold + sold.qty } : tt;
      }),
    });

    await queueOp("SELL_TICKETS", {
      clientId,
      eventId: event.id,
      eventClientId: event.clientId,
      // Codes are generated client-side and already shown to the buyer —
      // the server must reuse these exact codes rather than generating its
      // own, or the code on screen would silently stop matching what's
      // actually valid once this order syncs.
      items: selection.map((s) => ({
        ticketTypeId: s.tt.id,
        quantity: s.qty,
        codes: tickets.filter((t) => t.ticketTypeId === s.tt.id).map((t) => t.code),
      })),
    });

    // Update the address bar without a client-side route transition — a
    // never-before-visited dynamic route needs a server round-trip in the
    // App Router, which defeats the purpose when this purchase just
    // happened fully offline. Rendering the confirmation inline works
    // regardless of connectivity; the URL still becomes a valid deep link.
    window.history.replaceState(null, "", `/orders/${clientId}`);
    setPlacing(false);
    setPlacedOrder(order);
  }

  return (
    <div className="mx-auto max-w-4xl px-4 pb-20 pt-6 sm:px-6">
      <Link href="/" className="text-sm text-muted hover:text-foreground">← Back to browse</Link>

      <div className="mt-4 overflow-hidden rounded-2xl border border-border">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={event.imageUrl} alt={event.title} className="h-64 w-full object-cover sm:h-80" />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <div className="mb-3 flex items-center gap-2">
            <span className="pill">{event.category}</span>
            {event.status === "CANCELLED" && (
              <span className="pill border-danger/40 bg-danger/10 text-danger">Cancelled</span>
            )}
          </div>
          <h1 className="text-balance text-2xl font-bold sm:text-3xl">{event.title}</h1>
          <p className="mt-2 text-muted">{formatDateTime(event.startsAt)}</p>
          <p className="text-muted">{event.venue} · {event.city}</p>
          <p className="mt-1 text-xs text-muted">Organized by {event.organizerName}</p>
          <p className="mt-6 whitespace-pre-line leading-relaxed text-foreground/90">
            {event.description}
          </p>

          {event.status === "LIVE" && (
            <Link
              href="/account/wallet"
              className="mt-4 inline-flex text-sm font-medium text-accent-hover"
            >
              Get a cashless wallet for this event →
            </Link>
          )}

          {(event.vendors.length > 0 || (event.vendorApplicationsOpen && new Date(event.startsAt) > new Date())) && (
            <div className="mt-8 border-t border-border pt-6">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-semibold">Vendors at this event</h2>
                {event.vendorApplicationsOpen && new Date(event.startsAt) > new Date() && (
                  <Link href={`/events/${slug}/vendors/apply`} className="text-sm font-medium text-accent-hover">
                    Apply as a vendor →
                  </Link>
                )}
              </div>
              {event.vendors.length === 0 ? (
                <p className="text-sm text-muted">No vendors confirmed yet.</p>
              ) : (
                <ul className="space-y-2">
                  {event.vendors.map((v) => (
                    <li key={v.id} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
                      <span>{v.name}</span>
                      <span className="text-muted">
                        {v.category}{v.boothNumber ? ` · Booth ${v.boothNumber}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {event.status === "CANCELLED" ? (
          <div className="card h-fit p-5">
            <p className="font-semibold text-danger">This event has been cancelled.</p>
            <p className="mt-2 text-sm text-muted">
              Tickets are no longer on sale. If you already have a ticket,
              contact the organizer about a refund.
            </p>
          </div>
        ) : (
        <div className="card h-fit p-5">
          {step === "select" && (
            <>
              <h2 className="mb-4 font-semibold">Select tickets</h2>
              <div className="space-y-4">
                {event.ticketTypes.map((tt) => {
                  const remaining = tt.quantityTotal - tt.quantitySold;
                  const qty = quantities[tt.id] ?? 0;
                  return (
                    <div key={tt.id} className="border-b border-border pb-4 last:border-0 last:pb-0">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-medium">{tt.name}</p>
                          <p className="text-sm text-muted">{formatCents(tt.priceCents, event.currency)}</p>
                          <p className="text-xs text-muted">
                            {remaining > 0 ? `${remaining} left` : "Sold out"}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            className="btn-secondary h-8 w-8 !rounded-full !p-0"
                            disabled={qty <= 0}
                            onClick={() => setQty(tt.id, qty - 1, remaining)}
                          >
                            −
                          </button>
                          <span className="w-5 text-center text-sm">{qty}</span>
                          <button
                            className="btn-secondary h-8 w-8 !rounded-full !p-0"
                            disabled={remaining <= 0 || qty >= remaining}
                            onClick={() => setQty(tt.id, qty + 1, remaining)}
                          >
                            +
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-5 flex items-center justify-between text-sm">
                <span className="text-muted">Total</span>
                <span className="font-semibold">{formatCents(totalCents, event.currency)}</span>
              </div>
              <button
                className="btn-primary mt-4 w-full"
                disabled={totalQty === 0}
                onClick={() => setStep("confirm")}
              >
                Continue
              </button>
            </>
          )}

          {step === "confirm" && (
            <>
              <h2 className="mb-4 font-semibold">Confirm & pay</h2>
              <div className="space-y-2 text-sm">
                {selection.map((s) => (
                  <div key={s.tt.id} className="flex justify-between">
                    <span>{s.qty}× {s.tt.name}</span>
                    <span>{formatCents(s.tt.priceCents * s.qty, event.currency)}</span>
                  </div>
                ))}
                <div className="flex justify-between border-t border-border pt-2 font-semibold">
                  <span>Total</span>
                  <span>{formatCents(totalCents)}</span>
                </div>
              </div>

              <div className="mt-4 rounded-lg border border-border bg-surface2 p-3 text-xs text-muted">
                Test checkout — no real payment is processed. Purchases complete
                instantly, even offline, and sync automatically when connected.
              </div>

              {!user && (
                <p className="mt-3 text-xs text-warn">
                  You&apos;ll need to log in to complete this purchase.
                </p>
              )}

              <div className="mt-4 flex gap-2">
                <button className="btn-secondary flex-1" onClick={() => setStep("select")}>
                  Back
                </button>
                <button className="btn-primary flex-1" disabled={placing} onClick={placeOrder}>
                  {placing ? "Placing…" : user ? `Pay ${formatCents(totalCents, event.currency)}` : "Log in to pay"}
                </button>
              </div>
            </>
          )}
        </div>
        )}
      </div>
    </div>
  );
}
