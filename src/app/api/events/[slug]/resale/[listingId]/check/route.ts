import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { checkResalePurchase } from "@/lib/resale";

// Polled by the buyer's browser after a PENDING mobile-money charge — AirPay
// has no webhook, only Order Verification (see payments/airpay.ts).
export async function POST(_request: Request, { params }: { params: { slug: string; listingId: string } }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 });
  }
  const result = await checkResalePurchase(session.user.id, params.listingId);
  if (!result.ok) {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json(result);
}
