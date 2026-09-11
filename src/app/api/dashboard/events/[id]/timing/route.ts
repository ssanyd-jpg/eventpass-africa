import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getTimingDashboardData } from "@/lib/timing-data";

// Powers the organiser timing dashboard (src/app/dashboard/events/[id]/
// timing/page.tsx). Same access rule as reconciliation/forecast: any org
// member except GATE_CREW (their surface is the timing SCANNER, not this
// stats dashboard), then the event must belong to the caller's org.
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

  const data = await getTimingDashboardData(params.id);
  if (!data) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, ...data });
}
