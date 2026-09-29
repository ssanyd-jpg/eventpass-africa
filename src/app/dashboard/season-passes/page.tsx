import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { formatCents, formatDate } from "@/lib/format";
import { listSeasonPasses } from "@/lib/season-pass";
import SeasonPassForm from "./SeasonPassForm";
import SeasonPassRow from "./SeasonPassRow";

const STATUS_LABEL: Record<string, string> = { DRAFT: "Draft", ACTIVE: "Active", EXPIRED: "Expired" };
const STATUS_STYLE: Record<string, string> = {
  DRAFT: "pill",
  ACTIVE: "pill border-ok/40 bg-ok/10 text-ok",
  EXPIRED: "pill border-danger/40 bg-danger/10 text-danger",
};

// Server-rendered, non-offline — same "org-wide settings, low-frequency, no
// gate-offline requirement" reasoning as dashboard/loyalty/page.tsx. A
// season pass belongs to the organisation, not to one event, same scope as
// Loyalty rewards/Team/Withdrawals/Audit.
export default async function SeasonPassesPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login?callbackUrl=/dashboard/season-passes");
  }
  if (session.user.organizationRole === "GATE_CREW") {
    redirect("/dashboard");
  }

  const passes = await listSeasonPasses(session.user.organizationId);

  return (
    <div className="mx-auto max-w-4xl px-4 pb-20 pt-8 sm:px-6">
      <Link href="/dashboard" className="text-sm text-muted hover:text-foreground">← Dashboard</Link>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Season passes</h1>
          <p className="text-sm text-muted">
            Multi-event passes (e.g. a full home-match season) that renew themselves via WhatsApp + AirPay.
          </p>
        </div>
      </div>

      <div className="mt-6">
        <SeasonPassForm />
      </div>

      <h2 className="mb-3 mt-8 font-semibold">Your season passes</h2>
      {passes.length === 0 ? (
        <div className="card p-8 text-center text-muted">No season passes yet — create one above.</div>
      ) : (
        <div className="space-y-3">
          {passes.map((p) => (
            <div key={p.id} className="card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium">
                    <Link href={`/dashboard/season-passes/${p.id}`} className="hover:underline">{p.name}</Link>{" "}
                    <span className={STATUS_STYLE[p.status] ?? "pill"}>{STATUS_LABEL[p.status] ?? p.status}</span>
                  </p>
                  <p className="text-xs text-muted">
                    {formatCents(p.price, p.currency)} · {formatDate(p.startDate)} – {formatDate(p.endDate)}
                    {p.maxHolders != null ? ` · max ${p.maxHolders} holders` : ""}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {p.holderCount} holder{p.holderCount === 1 ? "" : "s"} · {formatCents(p.revenueCents, p.currency)} revenue
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    Renewals: {p.renewalBreakdown.active} active · {p.renewalBreakdown.offered} offered · {p.renewalBreakdown.confirmed} confirmed · {p.renewalBreakdown.declined} declined
                  </p>
                </div>
                <Link href={`/dashboard/season-passes/${p.id}`} className="btn-secondary shrink-0">Manage →</Link>
              </div>

              <SeasonPassRow seasonPass={p} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
