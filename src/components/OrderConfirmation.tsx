"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { LocalOrder } from "@/lib/db";
import { formatCents } from "@/lib/format";
import { useAppSession } from "@/lib/use-app-session";
import TicketQr from "@/components/TicketQr";

interface PendingTransfer {
  id: string;
  ticketId: string;
  toEmail: string;
  expiresAt: string;
}

// Per-ticket "Transfer" form/state — isolated so opening one ticket's form
// doesn't re-render every other ticket card in the order.
function TransferControl({
  ticketId,
  pending,
  onSent,
  onCancelled,
}: {
  ticketId: string;
  pending: PendingTransfer | undefined;
  onSent: (t: PendingTransfer) => void;
  onCancelled: (ticketId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (pending) {
    return (
      <div className="mt-2 flex items-center justify-between rounded-lg border border-border bg-surface2 px-3 py-2 text-xs">
        <span className="text-muted">Transfer pending — sent to {pending.toEmail}</span>
        <button
          type="button"
          className="font-medium text-danger hover:underline"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const res = await fetch(`/api/tickets/transfer/${pending.id}/cancel`, { method: "POST" });
            const data = await res.json();
            setBusy(false);
            if (data.ok) onCancelled(ticketId);
          }}
        >
          {busy ? "Cancelling…" : "Cancel"}
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button type="button" className="mt-2 text-xs font-medium text-accent-hover" onClick={() => setOpen(true)}>
        Transfer this ticket →
      </button>
    );
  }

  return (
    <form
      className="mt-2 flex flex-col gap-2 rounded-lg border border-border bg-surface2 p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const res = await fetch("/api/tickets/transfer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticketId, toEmail: email }),
        });
        const data = await res.json();
        setBusy(false);
        if (!data.ok) {
          setError(data.error ?? "Couldn't send this transfer.");
          return;
        }
        setOpen(false);
        onSent({ id: data.id, ticketId, toEmail: data.toEmail, expiresAt: data.expiresAt });
      }}
    >
      <label className="text-xs text-muted" htmlFor={`transfer-${ticketId}`}>Recipient&apos;s email</label>
      <input
        id={`transfer-${ticketId}`}
        type="email"
        required
        className="input"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex gap-2">
        <button type="button" className="btn-secondary flex-1 !py-1.5 text-xs" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button type="submit" disabled={busy} className="btn-primary flex-1 !py-1.5 text-xs">
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
    </form>
  );
}

export default function OrderConfirmation({ order }: { order: LocalOrder }) {
  const { user } = useAppSession();
  const [pendingByTicket, setPendingByTicket] = useState<Record<string, PendingTransfer>>({});

  const realTicketIds = order.tickets.filter((t) => !t.id.startsWith("local:")).map((t) => t.id);

  useEffect(() => {
    if (realTicketIds.length === 0) return;
    fetch(`/api/tickets/transfer?ticketIds=${realTicketIds.join(",")}`)
      .then((res) => res.json())
      .then((data) => {
        if (!data.ok) return;
        const map: Record<string, PendingTransfer> = {};
        for (const t of data.transfers) map[t.ticketId] = t;
        setPendingByTicket(map);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.id]);

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
        {order.discountRejectReason && (
          <p className="mt-3 inline-flex items-center gap-2 rounded-full border border-warn/40 bg-warn/10 px-3 py-1 text-xs text-warn">
            Your discount code couldn&apos;t be applied — charged in full.
          </p>
        )}
      </div>

      <div className="mt-8 space-y-3">
        {order.tickets.map((t, i) => {
          const holderId = t.currentHolderUserId ?? order.userId;
          const canTransfer = !!user && user.id === holderId && !t.checkedIn && !t.id.startsWith("local:");
          return (
            <div key={t.id} className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-dashed border-border p-4">
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted">{t.ticketTypeName}</p>
                  <p className="text-sm text-muted">Ticket {i + 1} of {order.tickets.length}</p>
                </div>
                {t.checkedIn ? (
                  <span className="pill border-ok/40 bg-ok/10 text-ok">Checked in</span>
                ) : t.currentHolderUserId ? (
                  <span className="pill">Transferred</span>
                ) : (
                  <span className="pill">Valid</span>
                )}
              </div>
              <div className="flex flex-col items-center gap-3 p-4 sm:flex-row sm:items-center">
                <TicketQr code={t.code} />
                <div className="text-center sm:text-left">
                  <p className="font-mono text-2xl font-bold tracking-widest text-accent-hover">{t.code}</p>
                  <p className="mt-1 text-xs text-muted">Show this QR code or code at the gate for entry.</p>
                  {canTransfer && (
                    <TransferControl
                      ticketId={t.id}
                      pending={pendingByTicket[t.id]}
                      onSent={(pt) => setPendingByTicket((m) => ({ ...m, [t.id]: pt }))}
                      onCancelled={(ticketId) =>
                        setPendingByTicket((m) => {
                          const next = { ...m };
                          delete next[ticketId];
                          return next;
                        })
                      }
                    />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="card mt-6 p-4">
        {(order.discountCents ?? 0) > 0 && (
          <div className="flex justify-between text-sm text-ok">
            <span>Discount ({order.discountCode}{order.discountTicketTypeName ? ` · ${order.discountTicketTypeName}` : ""})</span>
            <span>−{formatCents(order.discountCents ?? 0, order.currency)}</span>
          </div>
        )}
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
