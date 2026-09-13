import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getAirpayReconciliationData, canAccessAirpayReconciliation } from "@/lib/airpay-reconciliation-data";

// Powers the AirPay reconciliation page (src/app/dashboard/events/[id]/
// airpay-reconciliation/page.tsx). OWNER only — this is financial data,
// stricter than the Session 9 cash-reconciliation/forecast routes beside
// it, which only block GATE_CREW.
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

  const data = await getAirpayReconciliationData(params.id);
  if (!data) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, ...data });
}
