import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSponsor, getSponsorLeads, buildSponsorLeadsCsv } from "@/lib/sponsor-leads";
import { slugify } from "@/lib/format";

// Mirrors src/app/api/dashboard/analytics/export/route.ts's exact shape —
// session-authenticated, GATE_CREW blocked (STAFF/OWNER allowed), same
// access rule as the leads page itself. Per-sponsor, not a combined
// all-sponsors export: the downstream recipient of this file is the
// sponsor themselves, and a combined export risks leaking one sponsor's
// leads into a file meant for another.
export async function GET(_request: Request, { params }: { params: { id: string; sponsorId: string } }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, reason: "UNAUTHENTICATED" }, { status: 401 });
  }
  if (session.user.organizationRole === "GATE_CREW") {
    return NextResponse.json({ ok: false, reason: "FORBIDDEN" }, { status: 403 });
  }

  const sponsor = await getSponsor(session.user.organizationId, params.sponsorId);
  if (!sponsor || sponsor.eventId !== params.id) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  const leads = await getSponsorLeads(sponsor.id);
  const csv = buildSponsorLeadsCsv(sponsor.name, leads);
  const filename = `sponsor-leads-${slugify(sponsor.name)}.csv`;

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
