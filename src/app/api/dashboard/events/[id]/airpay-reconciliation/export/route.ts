import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getAirpayExportData, buildAirpayReconciliationCsv, canAccessAirpayReconciliation } from "@/lib/airpay-reconciliation-data";
import { slugify } from "@/lib/format";

// CSV export of the full transaction list (point 3) — same shape as the
// Session 9 reconciliation export beside it, but OWNER only, matching the
// data route above.
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, reason: "UNAUTHENTICATED" }, { status: 401 });
  }
  if (!canAccessAirpayReconciliation(session.user.organizationRole)) {
    return NextResponse.json({ ok: false, reason: "FORBIDDEN" }, { status: 403 });
  }

  const event = await prisma.event.findUnique({ where: { id: params.id }, select: { organizationId: true } });
  if (!event || event.organizationId !== session.user.organizationId) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  const data = await getAirpayExportData(params.id);
  if (!data) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  const csv = buildAirpayReconciliationCsv(data.eventTitle, data.rows);
  const filename = `airpay-reconciliation-${slugify(data.eventTitle)}.csv`;

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
