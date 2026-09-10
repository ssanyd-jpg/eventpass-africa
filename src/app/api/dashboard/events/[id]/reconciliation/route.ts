import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getReconciliationData } from "@/lib/reconciliation";

// Powers the reconciliation page (src/app/dashboard/events/[id]/
// reconciliation/page.tsx) and the pre-close unreconciled-operators check
// in the event dashboard's cancelEvent(). Access mirrors the analytics
// export route: any org member except GATE_CREW, then the event must
// belong to the caller's organisation. The heavy lifting is in
// getReconciliationData (src/lib/reconciliation.ts), split out so it's
// testable without auth().
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

  return NextResponse.json({ ok: true, ...data });
}
