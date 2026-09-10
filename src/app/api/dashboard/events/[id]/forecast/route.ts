import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getForecastPageData, canAccessForecast } from "@/lib/revenue-forecast-data";

// Page data for /dashboard/events/[id]/forecast. Same access rule as the
// reconciliation and analytics-export routes: any org member except
// GATE_CREW, then the event must belong to the caller's organisation.
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, reason: "UNAUTHENTICATED" }, { status: 401 });
  }
  if (!canAccessForecast(session.user.organizationRole)) {
    return NextResponse.json({ ok: false, reason: "FORBIDDEN" }, { status: 403 });
  }

  const event = await prisma.event.findUnique({ where: { id: params.id }, select: { organizationId: true } });
  if (!event || event.organizationId !== session.user.organizationId) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  const data = await getForecastPageData(params.id);
  if (!data) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, ...data });
}
