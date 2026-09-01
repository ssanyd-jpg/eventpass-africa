import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { formatDateTime } from "@/lib/format";
import { getSupportTicketDetailForBuyer } from "@/lib/support-handlers";
import { replyAsBuyer } from "../actions";

export default async function SupportTicketDetailPage({ params }: { params: { ticketId: string } }) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/login?callbackUrl=/account/support/${params.ticketId}`);
  }

  let detail;
  try {
    detail = await getSupportTicketDetailForBuyer(session.user.id, params.ticketId);
  } catch {
    return (
      <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 text-center sm:px-6">
        <Link href="/account/support" className="text-sm text-muted hover:text-foreground">← Support</Link>
        <p className="mt-10 font-semibold">Ticket not found.</p>
      </div>
    );
  }
  const { ticket, replies, eventTitle } = detail;

  return (
    <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 sm:px-6">
      <Link href="/account/support" className="text-sm text-muted hover:text-foreground">← Support</Link>
      <h1 className="mb-1 mt-3 text-2xl font-bold">{ticket.subject}</h1>
      <p className="mb-6 text-sm text-muted">
        {eventTitle ?? "General"} · {ticket.status === "OPEN" ? "Open" : "Resolved"}
      </p>

      <div className="card mb-6 divide-y divide-border">
        <div className="p-4 text-sm">
          <p>{ticket.body}</p>
          <p className="mt-1 text-xs text-muted">You · {formatDateTime(ticket.createdAt)}</p>
        </div>
        {replies.map((r) => (
          <div key={r.id} className="p-4 text-sm">
            <p>{r.body}</p>
            <p className="mt-1 text-xs text-muted">
              {r.isFromOrganizer ? r.authorName : "You"} · {formatDateTime(r.createdAt)}
            </p>
          </div>
        ))}
      </div>

      <form
        action={async (formData) => {
          "use server";
          await replyAsBuyer(ticket.id, formData);
        }}
        className="card space-y-3 p-4"
      >
        <textarea name="body" className="input min-h-20" placeholder="Write a reply…" required />
        <button type="submit" className="btn-primary text-sm">Send reply</button>
      </form>
    </div>
  );
}
