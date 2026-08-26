import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { runSettlement } from "@/lib/settlement-handlers";
import { logAudit } from "@/lib/audit";

const runSettlementSchema = z.object({
  mobileMoneyAccountId: z.string().min(1).optional(),
});

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, reason: "UNAUTHENTICATED" }, { status: 401 });
  }
  // Previously unchecked — any authenticated org member, regardless of
  // role, could trigger a payout run. Same class of gap closed for the
  // gate/wallet handlers earlier; settlements are an OWNER-only action,
  // matching the team/invite routes.
  if (session.user.organizationRole !== "OWNER") {
    return NextResponse.json({ ok: false, reason: "FORBIDDEN" }, { status: 403 });
  }

  const rawBody = await request.json().catch(() => ({}));
  const parsed = runSettlementSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, reason: "INVALID_PAYLOAD" }, { status: 400 });
  }

  const result = await runSettlement(session.user.organizationId, parsed.data.mobileMoneyAccountId);

  if (result.ok) {
    await logAudit({
      organizationId: session.user.organizationId,
      actorUserId: session.user.id,
      actorName: session.user.name ?? session.user.email ?? "Unknown",
      action: "SETTLEMENT_RUN",
      summary: `Ran settlement — ${result.ordersSettled} order(s), ${result.settlements.length} currenc${result.settlements.length === 1 ? "y" : "ies"}`,
    });
  }

  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
