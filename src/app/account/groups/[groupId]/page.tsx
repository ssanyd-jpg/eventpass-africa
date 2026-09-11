import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { formatCents, formatDateTime } from "@/lib/format";
import { getGroupDetail } from "@/lib/ticket-group-data";

const TYPE_LABEL: Record<string, string> = {
  TOPUP: "Top-up",
  SALE: "Purchase",
  SPONSOR_TAP: "Sponsor tap",
  WITHDRAWAL: "Withdrawal",
  CARRY_OVER: "Carry-over",
};

const STATUS_STYLE: Record<string, string> = {
  COMPLETED: "border-ok/40 bg-ok/10 text-ok",
  PENDING: "border-warn/40 bg-warn/10 text-warn",
  FAILED: "border-danger/40 bg-danger/10 text-danger",
};

export default async function GroupDetailPage({ params }: { params: { groupId: string } }) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/login?callbackUrl=/account/groups/${params.groupId}`);
  }

  const group = await getGroupDetail(params.groupId, session.user.id);
  if (!group) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 sm:px-6">
      <Link href="/account/groups" className="text-sm text-muted hover:text-foreground">← My Groups</Link>
      <h1 className="mb-1 mt-3 text-2xl font-bold">{group.name}</h1>
      <p className="mb-6 text-sm text-muted">{group.eventTitle}</p>

      <div className="card flex flex-col items-center gap-3 p-6 text-center">
        <p className="text-xs uppercase tracking-wide text-muted">Shared wallet balance</p>
        <p className="text-3xl font-bold">{formatCents(group.balanceCents, group.currency)}</p>
        <Link href={`/account/wallet/${group.sharedWalletId}`} className="btn-primary mt-2 w-full">
          Top up
        </Link>
      </div>

      <h2 className="mb-3 mt-8 font-semibold">Members</h2>
      <div className="card divide-y divide-border">
        {group.members.map((m) => (
          <div key={m.ticketId} className="flex items-center justify-between p-3 text-sm">
            <div>
              <p className="font-medium">{m.memberName ?? "Unnamed member"}</p>
              <p className="text-xs text-muted">{m.ticketTypeName} · {m.ticketCode}</p>
            </div>
            <span className={`pill ${m.provisioned ? "border-ok/40 bg-ok/10 text-ok" : "border-warn/40 bg-warn/10 text-warn"}`}>
              {m.provisioned ? "Provisioned" : "Not yet provisioned"}
            </span>
          </div>
        ))}
      </div>

      <h2 className="mb-3 mt-8 font-semibold">Transaction history</h2>
      {group.transactions.length === 0 ? (
        <div className="card p-8 text-center text-muted">No activity yet.</div>
      ) : (
        <div className="card divide-y divide-border">
          {group.transactions.map((t) => (
            <div key={t.id} className="flex items-center justify-between p-4 text-sm">
              <div>
                <p className="font-medium">
                  {TYPE_LABEL[t.type] ?? t.type}
                  {t.vendorName ? ` — ${t.vendorName}` : ""}
                  {t.item ? ` (${t.item})` : ""}
                </p>
                <p className="text-xs text-muted">
                  {formatDateTime(t.createdAt.toISOString())}
                  {t.spentByMemberName ? ` · ${t.spentByMemberName}` : " · member unknown"}
                </p>
              </div>
              <div className="text-right">
                {t.amountCents !== null && (
                  <p className="font-semibold">
                    {t.type === "TOPUP" ? "+" : "-"}
                    {formatCents(Math.abs(t.amountCents), t.currency)}
                  </p>
                )}
                <span className={`pill ${STATUS_STYLE[t.status] ?? ""}`}>{t.status}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
