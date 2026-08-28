import Link from "next/link";
import type { LocalOrder } from "@/lib/db";
import { formatCents } from "@/lib/format";
import TicketQr from "@/components/TicketQr";

export default function OrderConfirmation({ order }: { order: LocalOrder }) {
  return (
    <div className="mx-auto max-w-2xl px-4 pb-20 pt-10 sm:px-6">
      <div className="text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-ok/20 text-2xl text-ok">
          ✓
        </div>
        <h1 className="text-2xl font-bold">You&apos;re going!</h1>
        <p className="mt-1 text-muted">{order.eventTitle}</p>

        {order.syncStatus === "pending" && (
          <p className="mt-3 inline-flex items-center gap-2 rounded-full border border-warn/40 bg-warn/10 px-3 py-1 text-xs text-warn">
            Purchased offline — will sync automatically
          </p>
        )}
        {order.syncStatus === "conflict" && (
          <p className="mt-3 inline-flex items-center gap-2 rounded-full border border-danger/40 bg-danger/10 px-3 py-1 text-xs text-danger">
            {order.syncError ?? "Needs review by the organizer"}
          </p>
        )}
      </div>

      <div className="mt-8 space-y-3">
        {order.tickets.map((t, i) => (
          <div key={t.id} className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-dashed border-border p-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted">{t.ticketTypeName}</p>
                <p className="text-sm text-muted">Ticket {i + 1} of {order.tickets.length}</p>
              </div>
              {t.checkedIn ? (
                <span className="pill border-ok/40 bg-ok/10 text-ok">Checked in</span>
              ) : (
                <span className="pill">Valid</span>
              )}
            </div>
            <div className="flex flex-col items-center gap-3 p-4 sm:flex-row sm:items-center">
              <TicketQr code={t.code} />
              <div className="text-center sm:text-left">
                <p className="font-mono text-2xl font-bold tracking-widest text-accent-hover">{t.code}</p>
                <p className="mt-1 text-xs text-muted">Show this QR code or code at the gate for entry.</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="card mt-6 p-4">
        <div className="flex justify-between text-sm">
          <span className="text-muted">Order total</span>
          <span className="font-semibold">{formatCents(order.totalCents, order.currency)}</span>
        </div>
        {order.waiverAcceptedAt && (
          <p className="mt-2 text-xs text-muted">Waiver accepted at checkout.</p>
        )}
      </div>

      <div className="mt-6 flex gap-3">
        <Link href="/account/tickets" className="btn-secondary flex-1 text-center">My Tickets</Link>
        <Link href="/" className="btn-primary flex-1 text-center">Browse more events</Link>
      </div>
    </div>
  );
}
