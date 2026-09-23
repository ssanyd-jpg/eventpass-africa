import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { redeemReward } from "@/lib/loyalty-rewards";

// Redeems one reward for the signed-in attendee. eventId is optional context
// (see redeemReward's own comment) — this page-level route doesn't collect
// one, so WALLET_CREDIT falls back to whichever LIVE event of the reward's
// organiser the attendee has the soonest-starting wallet at.
export async function POST(_request: Request, { params }: { params: { rewardId: string } }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 });
  }
  const result = await redeemReward(session.user.id, params.rewardId);
  if (!result.ok) {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json(result);
}
