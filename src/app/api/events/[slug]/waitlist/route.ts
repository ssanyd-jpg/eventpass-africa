import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { joinWaitlist } from "@/lib/waitlist";

// Public, unauthenticated — no login required to join a waitlist (Session
// 26's guest-entry requirement). Attaches the caller's userId only when a
// session happens to exist; a logged-out buyer still gets a full guest
// entry, same as vendor applications require a session but this deliberately
// doesn't.
export async function POST(request: Request, { params }: { params: { slug: string } }) {
  const body = await request.json().catch(() => null);
  if (
    !body ||
    typeof body.ticketTypeId !== "string" ||
    typeof body.name !== "string" ||
    typeof body.phone !== "string" ||
    !body.name.trim() ||
    !body.phone.trim()
  ) {
    return NextResponse.json({ ok: false, reason: "INVALID_INPUT" }, { status: 400 });
  }

  const event = await prisma.event.findUnique({
    where: { slug: params.slug },
    select: { id: true, waitlistEnabled: true },
  });
  if (!event) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }
  if (!event.waitlistEnabled) {
    return NextResponse.json({ ok: false, reason: "WAITLIST_DISABLED" }, { status: 400 });
  }

  const ticketType = await prisma.ticketType.findUnique({ where: { id: body.ticketTypeId } });
  if (!ticketType || ticketType.eventId !== event.id) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }
  if (ticketType.quantitySold < ticketType.quantityTotal) {
    return NextResponse.json({ ok: false, reason: "NOT_SOLD_OUT" }, { status: 400 });
  }

  const session = await auth();
  const entry = await joinWaitlist({
    eventId: event.id,
    ticketTypeId: ticketType.id,
    userId: session?.user?.id ?? null,
    name: body.name.trim(),
    phone: body.phone.trim(),
    email: typeof body.email === "string" && body.email.trim() ? body.email.trim() : null,
  });

  return NextResponse.json({ ok: true, entryId: entry.id, position: entry.position });
}
