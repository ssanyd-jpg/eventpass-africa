import { NextResponse } from "next/server";
import { diagnosticOAuthCheck } from "@/lib/payments/airpay";

// Temporary, internal-only — added 2026-10-14 to trigger a real Airpay
// OAuth call from production on demand (rather than waiting for a real
// checkout attempt), so the diagnostic logging in airpay.ts's postForm can
// capture a fresh timestamp/egress-IP/response snapshot for Airpay's
// production-failure investigation. Gated by its own dedicated secret
// (AIRPAY_DIAG_SECRET) rather than CRON_SECRET — kept separate from the
// real scheduled cron jobs on purpose. Delete this route (and
// diagnosticOAuthCheck, and the AIRPAY_DIAG_SECRET env var) once that
// investigation is closed.
export async function GET(request: Request) {
  const secret = process.env.AIRPAY_DIAG_SECRET;
  const authHeader = request.headers.get("authorization");
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, reason: "UNAUTHORIZED" }, { status: 401 });
  }

  const result = await diagnosticOAuthCheck();
  return NextResponse.json(result);
}
