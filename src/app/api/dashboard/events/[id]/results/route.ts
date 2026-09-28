import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getMarathonResults, getDNFs, getMarathonRaceCounts } from "@/lib/marathon-results-data";
import { buildMarathonResultsPdf } from "@/lib/marathon-results-pdf";

// Official results PDF — OWNER/STAFF only (not GATE_CREW), same auth shape
// as the CSV export route at ../timing/export/route.ts.
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, reason: "UNAUTHENTICATED" }, { status: 401 });
  }
  if (session.user.organizationRole === "GATE_CREW") {
    return NextResponse.json({ ok: false, reason: "FORBIDDEN" }, { status: 403 });
  }

  const event = await prisma.event.findUnique({
    where: { id: params.id },
    select: { organizationId: true, title: true, venue: true, city: true, startsAt: true },
  });
  if (!event || event.organizationId !== session.user.organizationId) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  const [results, dnfs, counts] = await Promise.all([
    getMarathonResults(params.id),
    getDNFs(params.id),
    getMarathonRaceCounts(params.id),
  ]);

  const pdfBytes = await buildMarathonResultsPdf({
    eventTitle: event.title,
    venue: event.venue,
    city: event.city,
    startsAt: event.startsAt,
    totalStarters: counts.totalStarters,
    totalFinishers: counts.totalFinishers,
    dnfCount: counts.dnfCount,
    results,
    dnfs,
  });

  const filename = `chaap-official-results-${new Date().toISOString().slice(0, 10)}.pdf`;

  return new NextResponse(Buffer.from(pdfBytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
