import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { getSponsor, getSponsorLeads } from "@/lib/sponsor-leads";
import { formatDateTime } from "@/lib/format";

export default async function SponsorLeadsPage({
  params,
}: {
  params: { id: string; sponsorId: string };
}) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/login?callbackUrl=/dashboard/events/${params.id}/sponsors/${params.sponsorId}/leads`);
  }
  if (session.user.organizationRole === "GATE_CREW") {
    redirect("/dashboard");
  }

  const sponsor = await getSponsor(session.user.organizationId, params.sponsorId);
  if (!sponsor || sponsor.eventId !== params.id) {
    return (
      <div className="mx-auto max-w-3xl px-4 pb-20 pt-8 text-center sm:px-6">
        <Link href={`/dashboard/events/${params.id}/sponsors`} className="text-sm text-muted hover:text-foreground">
          ← Sponsors
        </Link>
        <p className="mt-10 font-semibold">This sponsor doesn&apos;t belong to your organization.</p>
      </div>
    );
  }

  const leads = await getSponsorLeads(sponsor.id);

  return (
    <div className="mx-auto max-w-3xl px-4 pb-20 pt-8 sm:px-6">
      <Link href={`/dashboard/events/${params.id}/sponsors`} className="text-sm text-muted hover:text-foreground">
        ← Sponsors
      </Link>
      <div className="mt-3 flex items-center justify-between">
        <h1 className="text-2xl font-bold">{sponsor.name} — Leads</h1>
        {leads.length > 0 && (
          <a
            href={`/api/dashboard/events/${params.id}/sponsors/${sponsor.id}/leads/export`}
            className="btn-secondary"
          >
            Export CSV
          </a>
        )}
      </div>
      <p className="mb-6 mt-1 text-sm text-muted">
        Everyone who tapped their wallet at this sponsor&apos;s booth, newest first.
      </p>

      {leads.length === 0 ? (
        <div className="card p-8 text-center text-muted">No leads captured yet.</div>
      ) : (
        <div className="card divide-y divide-border">
          {leads.map((l) => (
            <div key={l.id} className="p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">{l.wallet.owner.name}</p>
                <p className="text-xs text-muted">{formatDateTime(l.createdAt.toISOString())}</p>
              </div>
              <p className="text-muted">{l.wallet.owner.email}</p>
              {l.campaign && (
                <p className="mt-1 text-xs font-medium text-accent-hover">Redeemed: {l.campaign.name}</p>
              )}
              {l.note && <p className="mt-1 rounded-lg bg-surface2 p-2 text-xs">{l.note}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
