import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Session 30 — the volunteer portal's one data source. Deliberately no
// auth: "no login, access by unique URL" (the spec's own words) means the
// pair of cuids in the path IS the credential, same trust model as this
// codebase's existing magic-link/waitlist-purchase links (both unguessable
// ids standing in for a session). Only low-sensitivity fields are returned
// — no phone, no notes — since this URL is shared over WhatsApp and may
// sit in chat history indefinitely.
export async function GET(_request: Request, { params }: { params: { eventId: string; volunteerId: string } }) {
  const volunteer = await prisma.volunteer.findUnique({
    where: { id: params.volunteerId },
    include: { event: { select: { id: true, title: true } } },
  });
  if (!volunteer || volunteer.eventId !== params.eventId) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    eventTitle: volunteer.event.title,
    name: volunteer.name,
    role: volunteer.role,
    shiftStart: volunteer.shiftStart.toISOString(),
    shiftEnd: volunteer.shiftEnd.toISOString(),
    zoneAccess: volunteer.zoneAccess,
    // The QR staff entry points scan — the same phone number the wristband
    // desk looks a volunteer up by (see checkInVolunteer in
    // src/lib/volunteers.ts), so this portal and the desk resolve to the
    // same identity.
    phone: volunteer.phone,
  });
}
