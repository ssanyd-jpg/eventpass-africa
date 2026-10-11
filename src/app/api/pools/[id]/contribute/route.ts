import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { initiatePoolContribution } from "@/lib/ticket-pool";

// Plain route, not an outbox op — a pool contributor arrives from a shared
// link with no Dexie state of their own (see ticket-pool.ts's header
// comment on why contributions never go through the sync machinery), same
// reasoning as /api/wallet-transfer/resolve and /api/tickets/transfer/[id].
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Sign in to contribute to this pool." }, { status: 401 });
  }

  const body = await request.json();
  const result = await initiatePoolContribution({
    poolId: params.id,
    contributorUserId: session.user.id,
    amountCents: Number(body.amountCents),
    phoneNumber: body.phoneNumber ? String(body.phoneNumber) : undefined,
    mobileNetwork: body.mobileNetwork ? String(body.mobileNetwork) : undefined,
    clientId: String(body.clientId),
  });
  if (!result.ok) {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json(result);
}
