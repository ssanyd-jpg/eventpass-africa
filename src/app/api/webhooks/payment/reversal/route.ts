import { NextResponse } from "next/server";
import { handlePaymentReversal } from "@/lib/payment-reversal";

/**
 * Stub for AirPay's chargeback/reversal webhook. AirPay hasn't confirmed the
 * real payload shape or how they'll authenticate the call yet (see
 * payment-reversal.ts's header comment — this is the one AirPay event that
 * genuinely needs a webhook, unlike order confirmation, which is poll-based
 * — see verifyAirpayOrder in src/lib/payments/airpay.ts), so this is gated
 * behind the same CRON_SECRET bearer check every other not-yet-public
 * trigger in this codebase uses (see /api/cron/reminders) rather than a
 * signature scheme that doesn't exist yet. Swap this for AirPay's real
 * signature/shared-secret header the moment they document one — a static
 * bearer token is not an acceptable long-term webhook auth story.
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, reason: "UNAUTHORIZED" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "INVALID_JSON" }, { status: 400 });
  }

  const orderId = (body as Record<string, unknown> | null)?.orderId;
  const airpayRef = (body as Record<string, unknown> | null)?.airpayRef;
  if (typeof orderId !== "string" || typeof airpayRef !== "string") {
    return NextResponse.json({ ok: false, reason: "INVALID_BODY" }, { status: 400 });
  }

  const result = await handlePaymentReversal(orderId, airpayRef);
  if (!result.ok) {
    return NextResponse.json(result, { status: 404 });
  }
  return NextResponse.json(result);
}
