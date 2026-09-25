import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { createReceiveCode } from "@/lib/wallet-transfer";

// Session 37 — the recipient's "Receive transfer" button: mints a 6-digit
// code, valid 15 minutes, that a sender types into their transfer page.
// Online-only by nature (the code has to exist on the server before anyone
// can claim it); the sender's side of it can be entered offline.
const bodySchema = z.object({
  walletId: z.string().min(1),
  clientId: z.string().min(1),
});

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, reason: "UNAUTHENTICATED" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, reason: "INVALID_PAYLOAD" }, { status: 400 });
  }

  const { allowed } = await checkRateLimit(`wallet-transfer-code:${session.user.id}`, {
    limit: 10,
    windowMs: 60 * 1000,
  });
  if (!allowed) {
    return NextResponse.json({ ok: false, reason: "RATE_LIMITED" }, { status: 429 });
  }

  const wallet = await prisma.wallet.findUnique({ where: { id: parsed.data.walletId }, select: { ownerUserId: true } });
  if (!wallet || wallet.ownerUserId !== session.user.id) {
    return NextResponse.json({ ok: false, reason: "FORBIDDEN" }, { status: 403 });
  }

  const result = await createReceiveCode(parsed.data.walletId, parsed.data.clientId);
  if (!result.ok) {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json({ ok: true, code: result.code, expiresAt: result.expiresAt.toISOString() });
}
