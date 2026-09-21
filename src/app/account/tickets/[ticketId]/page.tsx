import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { formatDateTime } from "@/lib/format";
import { getTicketResaleState } from "@/lib/resale";
import ResaleControl from "./ResaleControl";

// Reads live listing state for the signed-in holder — never cacheable.
export const dynamic = "force-dynamic";

export default async function TicketDetailPage({ params }: { params: { ticketId: string } }) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/login?callbackUrl=/account/tickets/${params.ticketId}`);
  }

  // null for a ticket that doesn't exist or isn't the caller's to manage —
  // both look the same, so this never confirms another person's ticket id.
  const ticket = await getTicketResaleState(session.user.id, params.ticketId);
  if (!ticket) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 sm:px-6">
      <Link href="/account/tickets" className="text-sm text-muted hover:text-foreground">← My Tickets</Link>
      <h1 className="mb-1 mt-3 text-2xl font-bold">{ticket.eventTitle}</h1>
      <p className="mb-6 text-sm text-muted">
        {ticket.ticketTypeName} · {formatDateTime(ticket.eventStartsAt)}
      </p>

      <div className="card mb-6 flex items-center justify-between p-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Ticket code</p>
          <p className="font-mono text-2xl font-bold tracking-widest text-accent-hover">{ticket.code}</p>
        </div>
        {ticket.checkedIn ? (
          <span className="pill border-ok/40 bg-ok/10 text-ok">Checked in</span>
        ) : ticket.listing ? (
          <span className="pill border-warn/40 bg-warn/10 text-warn">Listed for resale</span>
        ) : (
          <span className="pill">Valid</span>
        )}
      </div>

      <h2 className="mb-3 font-semibold">Resell this ticket</h2>
      <ResaleControl ticket={ticket} />
    </div>
  );
}
