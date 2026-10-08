/**
 * POST /api/staff/debit
 *
 * Vendor tap-to-pay — charge a customer's wristband wallet via NFC.
 * Resolves NFC UID → Credential → Wallet.code, then delegates to
 * handleChargeWallet for the CAS balance decrement + transaction record.
 * Requires a valid staff Bearer JWT.
 *
 * Body:
 *   { nfcUid: string; amountCents: number; vendorId: string;
 *     eventId: string; clientId?: string; item?: string }
 *
 * clientId is an optional idempotency key — the mobile app generates a cuid
 * per tap so offline queue replays don't double-charge.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyStaffToken, extractBearerToken } from "@/lib/staff-token";
import { handleChargeWallet } from "@/lib/sync-handlers";

const bodySchema = z.object({
  nfcUid: z.string().min(1),
  amountCents: z.number().int().positive(),
  vendorId: z.string().min(1),
  eventId: z.string().min(1),
  clientId: z.string().min(1).optional(),
  item: z.string().max(120).optional(),
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

  const { nfcUid, amountCents, vendorId, eventId, clientId, item } = parsed.data;

  if (eventId !== claims.eventId) {
    return NextResponse.json({ error: "Token is not valid for this event" }, { status: 403 });
  }

  // Resolve NFC UID → wallet code via ACTIVE wallet-linked Credential
  const credential = await prisma.credential.findFirst({
    where: {
      organizationId: claims.orgId,
      nfcUid,
      status: "ACTIVE",
      walletId: { not: null },
    },
    include: { wallet: { select: { code: true, balanceCents: true, currency: true } } },
  });

  if (!credential?.wallet?.code) {
    return NextResponse.json({ ok: false, reason: "CREDENTIAL_NOT_FOUND" }, { status: 404 });
  }

  const result = await handleChargeWallet(claims.userId, claims.orgId, {
    clientId: clientId ?? crypto.randomUUID(),
    walletCode: credential.wallet.code,
    amountCents,
    vendorId,
    item: item ?? null,
  });

  if (!result.ok) {
    const status =
      result.reason === "FORBIDDEN" ? 403
      : result.reason === "WALLET_NOT_FOUND" ? 404
      : result.reason === "EVENT_NOT_LIVE" ? 409
      : result.reason === "VENDOR_NOT_APPROVED" ? 403
      : 422;
    return NextResponse.json({ ok: false, reason: result.reason }, { status });
  }

  // handleChargeWallet returns ok:true even on insufficient balance (declined:true)
  // so the transaction history is still written. Surface this distinctly.
  if ((result as any).declined) {
    return NextResponse.json(
      { ok: false, reason: "INSUFFICIENT_BALANCE", wallet: result.wallet },
      { status: 422 }
    );
  }

  return NextResponse.json({
    ok: true,
    transaction: result.transaction,
    newBalanceCents: result.wallet?.balanceCents ?? null,
    currency: result.wallet?.currency ?? "TZS",
  });
}
