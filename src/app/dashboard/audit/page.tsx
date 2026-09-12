import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { formatDateTime } from "@/lib/format";

const ACTION_LABEL: Record<string, string> = {
  EVENT_CREATED: "Event created",
  EVENT_EDITED: "Event edited",
  EVENT_CANCELLED: "Event cancelled",
  ORDER_REFUNDED: "Order refunded",
  VENDOR_ADDED: "Vendor added",
  VENDOR_APPROVED: "Vendor approved",
  VENDOR_REJECTED: "Vendor rejected",
  SPONSOR_ADDED: "Sponsor added",
  PAYOUT_ACCOUNT_ADDED: "Payout account added",
  SETTLEMENT_RUN: "Settlement run",
  MEMBER_INVITED: "Member invited",
  MEMBER_JOINED: "Member joined",
  MEMBER_REMOVED: "Member removed",
  DEVICE_REVOKED: "Device revoked",
  DEVICE_REACTIVATED: "Device reactivated",
  BROADCAST_SENT: "Broadcast sent",
  CREDENTIAL_REPLACED: "Credential replaced",
  CREDENTIAL_PROVISIONED: "Wristband provisioned",
  WITHDRAWAL_APPROVED: "Withdrawal approved",
  WITHDRAWAL_REJECTED: "Withdrawal rejected",
  VENDOR_PORTAL_LINK_SENT: "Vendor portal link sent",
  SPONSOR_PORTAL_LINK_SENT: "Sponsor portal link sent",
  VENDOR_SETTLEMENT_PROCESSING: "Vendor settlement marked processing",
  VENDOR_SETTLEMENT_PROCESSED: "Vendor settlement paid out",
  FLOAT_DECLARED: "Cash float declared",
  FORECAST_SAVED: "Revenue forecast saved",
  TIMING_POINTS_SAVED: "Timing points saved",
  GUN_STARTED: "Start gun fired",
};

// Server-rendered, non-offline — same reasoning as dashboard/team/page.tsx:
// low-frequency, doesn't need to work at a gate with no signal.
export default async function AuditLogPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login?callbackUrl=/dashboard/audit");
  }

  if (session.user.organizationRole !== "OWNER") {
    return (
      <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 text-center sm:px-6">
        <Link href="/dashboard" className="text-sm text-muted hover:text-foreground">← Dashboard</Link>
        <p className="mt-10 font-semibold">Only the organization owner can view the audit log.</p>
      </div>
    );
  }

  const entries = await prisma.auditLog.findMany({
    where: { organizationId: session.user.organizationId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return (
    <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 sm:px-6">
      <Link href="/dashboard" className="text-sm text-muted hover:text-foreground">← Dashboard</Link>
      <h1 className="mb-1 mt-3 text-2xl font-bold">Audit log</h1>
      <p className="mb-6 text-sm text-muted">Actions taken by your team, most recent first.</p>

      {entries.length === 0 ? (
        <div className="card p-8 text-center text-muted">Nothing logged yet.</div>
      ) : (
        <div className="card divide-y divide-border">
          {entries.map((e) => (
            <div key={e.id} className="p-4 text-sm">
              <p className="font-medium">{ACTION_LABEL[e.action] ?? e.action}</p>
              <p className="text-muted">{e.summary}</p>
              <p className="mt-1 text-xs text-muted">{e.actorName} · {formatDateTime(e.createdAt)}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
