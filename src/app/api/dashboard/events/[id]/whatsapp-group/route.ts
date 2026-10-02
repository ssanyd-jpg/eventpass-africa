import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getGroupOptInStats, shouldShowRevokeBanner } from "@/lib/whatsapp-group";
import { eventHasEnded } from "@/lib/carry-over";

// Page data for /dashboard/events/[id]/whatsapp-group, and the small status
// fetch the main event dashboard page uses for its revoke-link reminder
// banner. Same access rule as resale/waitlist's own data routes: any org
// member except GATE_CREW, then the event must belong to the caller's org.
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
    select: {
      id: true,
      title: true,
      organizationId: true,
      startsAt: true,
      endsAt: true,
      status: true,
      whatsappGroupEnabled: true,
      whatsappGroupLink: true,
      whatsappGroupArchivedAt: true,
      whatsappGroupLinkRevokedAt: true,
    },
  });
  if (!event || event.organizationId !== session.user.organizationId) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  const stats = await getGroupOptInStats(event.id);
  const eventEnded = event.status === "CANCELLED" || eventHasEnded(event);

  return NextResponse.json({
    ok: true,
    eventTitle: event.title,
    whatsappGroupEnabled: event.whatsappGroupEnabled,
    whatsappGroupLink: event.whatsappGroupLink,
    eventEnded,
    showRevokeBanner: shouldShowRevokeBanner(event),
    ...stats,
  });
}
