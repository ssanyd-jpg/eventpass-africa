import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { cancelTransfer } from "@/lib/ticket-transfer";

// A buyer who mistypes a recipient email needs recourse — see the
// TicketTransfer schema comment for why this deviates from
// OrganizationInvite (which has no cancel).
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 });
  }

  const result = await cancelTransfer(session.user.id, params.id);
  if (!result.ok) {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json(result);
}
