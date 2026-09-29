import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { formatCents, formatDate, formatDateTime } from "@/lib/format";
import { getSeasonPassDetail } from "@/lib/season-pass";
import EventLinker from "./EventLinker";
import WristbandProvision from "./WristbandProvision";

const RENEWAL_LABEL: Record<string, string> = {
  ACTIVE: "Active",
  RENEWAL_OFFERED: "Renewal offered",
  RENEWAL_CONFIRMED: "Renewed",
  RENEWAL_DECLINED: "Declined",
  EXPIRED: "Expired",
};
const RENEWAL_STYLE: Record<string, string> = {
  ACTIVE: "pill border-ok/40 bg-ok/10 text-ok",
  RENEWAL_OFFERED: "pill border-accent/40 bg-accent-soft text-accent-hover",
  RENEWAL_CONFIRMED: "pill border-ok/40 bg-ok/10 text-ok",
  RENEWAL_DECLINED: "pill border-danger/40 bg-danger/10 text-danger",
  EXPIRED: "pill",
};

export default async function SeasonPassDetailPage({ params }: { params: { id: string } }) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/login?callbackUrl=/dashboard/season-passes/${params.id}`);
  }
  if (session.user.organizationRole === "GATE_CREW") {
    redirect("/dashboard");
  }

  const pass = await getSeasonPassDetail(session.user.organizationId, params.id);
  if (!pass) notFound();

  return (
    <div className="mx-auto max-w-4xl px-4 pb-20 pt-8 sm:px-6">
      <Link href="/dashboard/season-passes" className="text-sm text-muted hover:text-foreground">← Season passes</Link>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{pass.name}</h1>
          <p className="text-sm text-muted">
            {formatCents(pass.price, pass.currency)} · {formatDate(pass.startDate)} – {formatDate(pass.endDate)}
          </p>
        </div>
        <a href={`/api/dashboard/season-passes/${pass.id}/holders`} className="btn-secondary">Export holders (CSV)</a>
      </div>
      {pass.description && <p className="mt-2 text-sm text-muted">{pass.description}</p>}

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="card p-4 text-center">
          <p className="text-2xl font-bold">{pass.holderCount}</p>
          <p className="text-xs text-muted">Holders</p>
        </div>
        <div className="card p-4 text-center">
          <p className="text-2xl font-bold">{formatCents(pass.revenueCents, pass.currency)}</p>
          <p className="text-xs text-muted">Revenue</p>
        </div>
        <div className="card p-4 text-center">
          <p className="text-2xl font-bold">{pass.renewalBreakdown.confirmed}</p>
          <p className="text-xs text-muted">Renewed</p>
        </div>
        <div className="card p-4 text-center">
          <p className="text-2xl font-bold">{pass.linkedEvents.length}</p>
          <p className="text-xs text-muted">Linked events</p>
        </div>
      </div>

      <h2 className="mb-3 mt-8 font-semibold">Linked events</h2>
      <div className="card p-4">
        {pass.linkedEvents.length === 0 ? (
          <p className="text-sm text-muted">No events linked yet — this pass grants entry nowhere until you link at least one.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {pass.linkedEvents.map((e) => (
              <li key={e.id}>{e.title} — {formatDate(e.startsAt)}</li>
            ))}
          </ul>
        )}
        <div className="mt-4 border-t border-dashed border-border pt-4">
          <EventLinker seasonPassId={pass.id} linkableEvents={pass.linkableEvents} />
        </div>
      </div>

      <h2 className="mb-3 mt-8 font-semibold">Holders</h2>
      {pass.holders.length === 0 ? (
        <div className="card p-8 text-center text-muted">No holders yet.</div>
      ) : (
        <div className="card divide-y divide-border">
          {pass.holders.map((h) => (
            <div key={h.id} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
              <div>
                <p className="font-medium">
                  {h.name} <span className={RENEWAL_STYLE[h.renewalStatus] ?? "pill"}>{RENEWAL_LABEL[h.renewalStatus] ?? h.renewalStatus}</span>
                </p>
                <p className="text-xs text-muted">{h.phone}{h.email ? ` · ${h.email}` : ""}</p>
                <p className="mt-1 text-xs text-muted">Purchased {formatDateTime(h.purchasedAt)}</p>
              </div>
              <WristbandProvision holderId={h.id} provisioned={!!h.credentialId} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
