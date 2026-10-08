/**
 * POST /api/staff/provision
 *
 * Wristband provisioning — links an NFC tag UID to a ticket.
 * Delegates to handleProvisionCredential after resolving ticket details.
 * Requires a valid staff Bearer JWT.
 *
 * Body: { ticketCode: string; nfcUid: string; eventId: string; clientId?: string }
 *
 * clientId is an optional idempotency key (cuid the mobile app generates)
 * so that offline queue replays don't double-provision.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyStaffToken, extractBearerToken } from "@/lib/staff-token";
import { handleProvisionCredential } from "@/lib/sync-handlers";

const bodySchema = z.object({
  ticketCode: z.string().min(1),
  nfcUid: z.string().min(1),
  eventId: z.string().min(1),
  clientId: z.string().min(1).optional(),
});

export async function POST(request: Request) {
  const rawToken = extractBearerToken(request.headers.get("authorization"));
  if (!rawToken) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let claims;
  try {
    claims = await verifyStaffToken(rawToken);
  } catch {
    return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  const { ticketCode, nfcUid, eventId, clientId } = parsed.data;

  if (eventId !== claims.eventId) {
    return NextResponse.json({ error: "Token is not valid for this event" }, { status: 403 });
  }

  // Resolve ticket id from the entered code
  const ticket = await prisma.ticket.findUnique({
    where: { code: ticketCode },
    select: { id: true, event: { select: { organizationId: true } } },
  });
  if (!ticket) {
    return NextResponse.json({ ok: false, reason: "TICKET_NOT_FOUND" }, { status: 404 });
  }
  if (ticket.event.organizationId !== claims.orgId) {
    return NextResponse.json({ ok: false, reason: "FORBIDDEN" }, { status: 403 });
  }

  const result = await handleProvisionCredential(claims.userId, claims.orgId, {
    clientId: clientId ?? crypto.randomUUID(),
    eventId,
    nfcUid,
    ticketId: ticket.id,
  });

  if (!result.ok) {
    const status =
      result.reason === "FORBIDDEN" ? 403
      : result.reason === "EVENT_NOT_SYNCED_YET" || result.reason === "TICKET_NOT_SYNCED_YET" ? 404
      : 422;
    return NextResponse.json({ ok: false, reason: result.reason }, { status });
  }

  return NextResponse.json({
    ok: true,
    credentials: result.credentials,
    wallet: result.wallet,
    attendeeName: result.user?.name ?? result.groupMemberName ?? null,
  });
}
