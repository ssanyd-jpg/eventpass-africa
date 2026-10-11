import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { settlePoolContribution } from "@/lib/ticket-pool";

// Polled by the contributor's own browser while their STK push is pending —
// same role as /api/wallet-transfer's status checks. Only the contributor
// who made this specific contribution can poll it.
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 });
  }

  const contribution = await prisma.poolContribution.findUnique({
    where: { id: params.id },
    select: { contributorUserId: true },
  });
  if (!contribution) {
    return NextResponse.json({ ok: false, reason: "CONTRIBUTION_NOT_FOUND" }, { status: 404 });
  }
  if (contribution.contributorUserId !== session.user.id) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  const result = await settlePoolContribution(params.id);
  if (!result.ok) {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json(result);
}
