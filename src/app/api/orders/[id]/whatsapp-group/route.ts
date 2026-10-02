import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

// Order-confirmation-page data: whether this order's event has the
// WhatsApp group feature on, and each of its tickets' current opt-in/
// invite-sent state — not synced onto LocalOrder/LocalTicket (see
// shapeOrder/shapeTicket's own explicit field lists), hence this small
// dedicated fetch, same precedent as the resale/post-event-memory routes.
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, reason: "UNAUTHENTICATED" }, { status: 401 });
  }

  const order = await prisma.order.findUnique({
    where: { id: params.id },
    select: {
      userId: true,
      event: { select: { title: true, whatsappGroupEnabled: true, whatsappGroupLink: true } },
      tickets: { select: { id: true, code: true, whatsappGroupOptedIn: true, whatsappGroupInviteSentAt: true } },
    },
  });
  if (!order || order.userId !== session.user.id) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    eventTitle: order.event.title,
    groupEnabled: order.event.whatsappGroupEnabled,
    groupLink: order.event.whatsappGroupLink,
    tickets: order.tickets.map((t) => ({
      id: t.id,
      code: t.code,
      optedIn: t.whatsappGroupOptedIn,
      inviteSentAt: t.whatsappGroupInviteSentAt,
    })),
  });
}
