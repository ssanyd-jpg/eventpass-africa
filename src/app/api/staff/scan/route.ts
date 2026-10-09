/**
 * POST /api/staff/scan
 *
 * Gate-scanner endpoint. Looks up a ticket via NFC UID (Credential.nfcUid)
 * or a directly-entered ticket code, then runs the same check-in logic as
 * the web portal. Requires a valid staff Bearer JWT.
 *
 * Body: { nfcUid?: string; ticketCode?: string; eventId: string }
 * Either nfcUid or ticketCode must be present.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyStaffToken, extractBearerToken } from "@/lib/staff-token";
import { handleCheckIn } from "@/lib/sync-handlers";

const bodySchema = z
  .object({
    nfcUid: z.string().min(1).optional(),
    ticketCode: z.string().min(1).optional(),
    eventId: z.string().min(1),
  })
  .refine((v) => v.nfcUid || v.ticketCode, {
    message: "Either nfcUid or ticketCode is required",
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

  const { nfcUid, ticketCode, eventId } = parsed.data;

  // Ensure the request is for the event this token is scoped to
  if (eventId !== claims.eventId) {
    return NextResponse.json({ error: "Token is not valid for this event" }, { status: 403 });
  }

  // Resolve ticket code from NFC UID when code wasn't supplied directly
  let resolvedTicketCode = ticketCode;
  if (!resolvedTicketCode && nfcUid) {
    const credential = await prisma.credential.findFirst({
      where: {
        organizationId: claims.orgId,
        nfcUid,
        status: "ACTIVE",
        ticketId: { not: null },
      },
      include: { ticket: { select: { code: true } } },
    });
    if (!credential?.ticket?.code) {
      return NextResponse.json(
        { ok: false, reason: "CREDENTIAL_NOT_FOUND" },
        { status: 404 }
      );
    }
    resolvedTicketCode = credential.ticket.code;
  }

  const result = await handleCheckIn(claims.userId, claims.orgId, {
    ticketCode: resolvedTicketCode,
    scannedAt: new Date().toISOString(),
  });

  if (!result.ok) {
    const status =
      result.reason === "FORBIDDEN" ? 403
      : result.reason === "TICKET_NOT_FOUND" ? 404
      : 422;
    return NextResponse.json({ ok: false, reason: result.reason }, { status });
  }

  return NextResponse.json({ ok: true, ticket: result.ticket, alreadyCheckedIn: result.alreadyCheckedIn ?? false });
}
