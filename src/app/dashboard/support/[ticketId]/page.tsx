import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { formatDateTime } from "@/lib/format";
import { getSupportTicketDetailForOrg } from "@/lib/support-handlers";
import { replyAsOrganizer, markResolved } from "../actions";

export default async function OrgSupportTicketDetailPage({ params }: { params: { ticketId: string } }) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/login?callbackUrl=/dashboard/support/${params.ticketId}`);
  }
  if (session.user.organizationRole === "GATE_CREW") {
    redirect("/dashboard");
  }

  let detail;
  try {
    detail = await getSupportTicketDetailForOrg(session.user.organizationId, params.ticketId);
  } catch {
    return (
      <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 text-center sm:px-6">
        <Link href="/dashboard/support" className="text-sm text-muted hover:text-foreground">← Support</Link>
        <p className="mt-10 font-semibold">Ticket not found.</p>
      </div>
    );
  }
  const { ticket, replies, eventTitle } = detail;

  return (
    <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 sm:px-6">
      <Link href="/dashboard/support" className="text-sm text-muted hover:text-foreground">← Support</Link>
      <div className="mt-3 flex items-center justify-between">
        <h1 className="text-2xl font-bold">{ticket.subject}</h1>
        {ticket.status === "OPEN" && (
          <form
            action={async () => {
              "use server";
              await markResolved(ticket.id);
            }}
          >
            <button type="submit" className="btn-secondary text-sm">Mark resolved</button>
          </form>
        )}
      </div>
      <p className="mb-6 mt-1 text-sm text-muted">
        {eventTitle ?? "General"} · {ticket.status === "OPEN" ? "Open" : "Resolved"}
      </p>

      <div className="card mb-6 divide-y divide-border">
        <div className="p-4 text-sm">
          <p>{ticket.body}</p>
          <p className="mt-1 text-xs text-muted">Buyer · {formatDateTime(ticket.createdAt)}</p>
        </div>
        {replies.map((r) => (
          <div key={r.id} className="p-4 text-sm">
            <p>{r.body}</p>
            <p className="mt-1 text-xs text-muted">
              {r.isFromOrganizer ? r.authorName : "Buyer"} · {formatDateTime(r.createdAt)}
            </p>
          </div>
        ))}
      </div>

      <form
        action={async (formData) => {
          "use server";
          await replyAsOrganizer(ticket.id, formData);
        }}
        className="card space-y-3 p-4"
      >
        <textarea name="body" className="input min-h-20" placeholder="Write a reply…" required />
        <button type="submit" className="btn-primary text-sm">Send reply</button>
      </form>
    </div>
  );
}
