import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { formatDateTime } from "@/lib/format";
import { listSupportTicketsForBuyer } from "@/lib/support-handlers";

const STATUS_STYLE: Record<string, string> = {
  OPEN: "border-warn/40 bg-warn/10 text-warn",
  RESOLVED: "border-ok/40 bg-ok/10 text-ok",
};

export default async function MySupportTicketsPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login?callbackUrl=/account/support");
  }

  const tickets = await listSupportTicketsForBuyer(session.user.id);

  return (
    <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold">Support</h1>
      <p className="mb-6 text-sm text-muted">Questions you&apos;ve sent to event organizers.</p>

      {tickets.length === 0 ? (
        <div className="card p-8 text-center text-muted">No support tickets yet.</div>
      ) : (
        <div className="card divide-y divide-border">
          {tickets.map((t) => (
            <Link
              key={t.id}
              href={`/account/support/${t.id}`}
              className="flex items-center justify-between gap-3 p-4 text-sm transition hover:bg-surface2"
            >
              <div>
                <p className="font-medium">{t.subject}</p>
                <p className="text-xs text-muted">
                  {t.event?.title ?? "General"} · {formatDateTime(t.updatedAt)}
                </p>
              </div>
              <span className={`pill ${STATUS_STYLE[t.status] ?? ""}`}>
                {t.status === "OPEN" ? "Open" : "Resolved"}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
