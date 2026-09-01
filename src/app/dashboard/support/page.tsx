import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { formatDateTime } from "@/lib/format";
import { listSupportTicketsForOrg } from "@/lib/support-handlers";

const STATUS_STYLE: Record<string, string> = {
  OPEN: "border-warn/40 bg-warn/10 text-warn",
  RESOLVED: "border-ok/40 bg-ok/10 text-ok",
};

export default async function SupportTicketsPage({
  searchParams,
}: {
  searchParams: { status?: string };
}) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login?callbackUrl=/dashboard/support");
  }
  if (session.user.organizationRole === "GATE_CREW") {
    redirect("/dashboard");
  }

  const status = searchParams.status === "all" ? undefined : searchParams.status ?? "OPEN";
  const tickets = await listSupportTicketsForOrg(session.user.organizationId, status);

  return (
    <div className="mx-auto max-w-3xl px-4 pb-20 pt-8 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold">Support</h1>
      <p className="mb-4 text-sm text-muted">Questions and complaints sent in by attendees.</p>

      <div className="mb-4 flex gap-2 text-sm">
        <Link href="/dashboard/support" className={!searchParams.status || searchParams.status === "OPEN" ? "font-semibold text-foreground" : "text-muted"}>
          Open
        </Link>
        <Link href="/dashboard/support?status=all" className={searchParams.status === "all" ? "font-semibold text-foreground" : "text-muted"}>
          All
        </Link>
      </div>

      {tickets.length === 0 ? (
        <div className="card p-8 text-center text-muted">No tickets here.</div>
      ) : (
        <div className="card divide-y divide-border">
          {tickets.map((t) => (
            <Link
              key={t.id}
              href={`/dashboard/support/${t.id}`}
              className="flex items-center justify-between gap-3 p-4 text-sm transition hover:bg-surface2"
            >
              <div>
                <p className="font-medium">{t.subject}</p>
                <p className="text-xs text-muted">
                  {t.event?.title ?? "General"} · {formatDateTime(t.updatedAt)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {t.aiPriority === "HIGH" && (
                  <span className="pill border-danger/40 bg-danger/10 text-danger">High priority</span>
                )}
                <span className={`pill ${STATUS_STYLE[t.status] ?? ""}`}>
                  {t.status === "OPEN" ? "Open" : "Resolved"}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
