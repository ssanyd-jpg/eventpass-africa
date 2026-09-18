import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { listVolunteers } from "@/lib/volunteers";

// Page data for /dashboard/events/[id]/volunteers. Same access rule as the
// waitlist/forecast data routes: any org member except GATE_CREW, then the
// event must belong to the caller's organisation.
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
    select: { id: true, title: true, organizationId: true },
  });
  if (!event || event.organizationId !== session.user.organizationId) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  const volunteers = await listVolunteers(event.id);

  return NextResponse.json({
    ok: true,
    eventTitle: event.title,
    volunteers: volunteers.map((v) => ({
      id: v.id,
      name: v.name,
      phone: v.phone,
      email: v.email,
      role: v.role,
      shiftStart: v.shiftStart.toISOString(),
      shiftEnd: v.shiftEnd.toISOString(),
      zoneAccess: v.zoneAccess,
      status: v.status,
      notes: v.notes,
    })),
  });
}
