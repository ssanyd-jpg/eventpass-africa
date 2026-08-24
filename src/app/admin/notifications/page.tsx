import { prisma } from "@/lib/prisma";
import { formatDate } from "@/lib/format";

const TYPE_STYLE: Record<string, string> = {
  PASSWORD_RESET: "border-danger/40 bg-danger/10 text-danger",
  EVENT_CANCELLED: "border-warn/40 bg-warn/10 text-warn",
  ORDER_CONFIRMATION: "border-ok/40 bg-ok/10 text-ok",
  REFUND_ISSUED: "border-warn/40 bg-warn/10 text-warn",
};

export default async function AdminNotificationsPage() {
  const logs = await prisma.notificationLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return (
    <div>
      <p className="mb-4 text-sm text-muted">
        No email/SMS provider is connected yet — every notification the
        platform would have sent lands here instead. Password reset links in
        particular need to be manually relayed to the person from this list
        until a provider is wired up.
      </p>
      <div className="card divide-y divide-border">
        {logs.map((l) => (
          <div key={l.id} className="p-4 text-sm">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className={`pill ${TYPE_STYLE[l.type] ?? ""}`}>{l.type.replace(/_/g, " ")}</span>
              <span className="text-muted">{l.channel} → {l.recipient}</span>
              <span className="text-xs text-muted">{formatDate(l.createdAt)}</span>
            </div>
            <p className="font-medium">{l.subject}</p>
            <p className="whitespace-pre-wrap break-words text-muted">{l.body}</p>
          </div>
        ))}
        {logs.length === 0 && <p className="p-8 text-center text-muted">Nothing logged yet.</p>}
      </div>
    </div>
  );
}
