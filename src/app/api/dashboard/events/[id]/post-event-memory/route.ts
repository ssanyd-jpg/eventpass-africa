import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getPostEventMemoryStatus } from "@/lib/post-event-memory-data";

// Backs the "Send post-event memories" button on /dashboard/events/[id] —
// same access rule as the forecast/waitlist/reconciliation data routes: any
// org member except GATE_CREW, then the event must belong to the caller's
// organisation.
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
    select: { organizationId: true },
  });
  if (!event || event.organizationId !== session.user.organizationId) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  const status = await getPostEventMemoryStatus(params.id);
  if (!status) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, ...status });
}
