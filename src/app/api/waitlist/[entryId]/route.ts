import { NextResponse } from "next/server";
import { getWaitlistEntry, leaveWaitlist, WAITLIST_NOTIFICATION_WINDOW_HOURS } from "@/lib/waitlist";

// Public, unauthenticated — same "no login required" reasoning as the join
// route: a guest entry has no account to authenticate, so the entryId
// itself (a cuid, unguessable) is the access token, same shape as an order
// confirmation link.
export async function GET(_request: Request, { params }: { params: { entryId: string } }) {
  const entry = await getWaitlistEntry(params.entryId);
  if (!entry) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  const expiresAt = entry.notifiedAt
    ? new Date(entry.notifiedAt.getTime() + WAITLIST_NOTIFICATION_WINDOW_HOURS * 60 * 60 * 1000).toISOString()
    : null;

  return NextResponse.json({
    ok: true,
    entry: {
      id: entry.id,
      name: entry.name,
      status: entry.status,
      position: entry.position,
      notifiedAt: entry.notifiedAt ? entry.notifiedAt.toISOString() : null,
      expiresAt,
      eventSlug: entry.event.slug,
      eventTitle: entry.event.title,
      ticketTypeName: entry.ticketType.name,
    },
  });
}

export async function DELETE(_request: Request, { params }: { params: { entryId: string } }) {
  const entry = await leaveWaitlist(params.entryId);
  if (!entry) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
