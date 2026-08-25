import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { runSettlement } from "@/lib/settlement-handlers";

const runSettlementSchema = z.object({
  mobileMoneyAccountId: z.string().min(1).optional(),
});

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, reason: "UNAUTHENTICATED" }, { status: 401 });
  }

  const rawBody = await request.json().catch(() => ({}));
  const parsed = runSettlementSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, reason: "INVALID_PAYLOAD" }, { status: 400 });
  }

  const result = await runSettlement(session.user.organizationId, parsed.data.mobileMoneyAccountId);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
