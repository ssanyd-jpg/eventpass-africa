import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getReconciliationData, buildReconciliationCsv } from "@/lib/reconciliation";

// CSV export of the full reconciliation — same shape as
// src/app/api/dashboard/analytics/export/route.ts (buildCsvDocument via a
// lib helper, text/csv attachment response). Same access rule as the
// reconciliation data route beside it.
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, reason: "UNAUTHENTICATED" }, { status: 401 });
  }
  if (session.user.organizationRole === "GATE_CREW") {
    return NextResponse.json({ ok: false, reason: "FORBIDDEN" }, { status: 403 });
  }

  const event = await prisma.event.findUnique({ where: { id: params.id }, select: { organizationId: true } });
  if (!event || event.organizationId !== session.user.organizationId) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  const data = await getReconciliationData(params.id);
  if (!data) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  const csv = buildReconciliationCsv(data);
  const filename = `chaap-reconciliation-${new Date().toISOString().slice(0, 10)}.csv`;

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
