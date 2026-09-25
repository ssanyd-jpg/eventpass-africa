import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { resolveRecipient } from "@/lib/wallet-transfer";

// Session 37 — "who am I about to send this to?" for the transfer page.
// Deliberately an online-only route, not an outbox op: the whole point is to
// show the sender the recipient's first name BEFORE they commit, and that
// needs a live answer. (An offline code entry skips this step and is
// re-resolved when INITIATE_WALLET_TRANSFER syncs.)
//
// Rate-limited per user because this is an enumeration surface — a 6-digit
// code or a phone number can be guessed at — and returns nothing beyond the
// recipient's first name and the id the sender needs to confirm.
const bodySchema = z.discriminatedUnion("method", [
  z.object({ senderWalletId: z.string().min(1), method: z.literal("NFC"), nfcUid: z.string().min(1).max(100) }),
  z.object({ senderWalletId: z.string().min(1), method: z.literal("CODE"), code: z.string().min(1).max(20) }),
  z.object({ senderWalletId: z.string().min(1), method: z.literal("PHONE"), phone: z.string().min(6).max(20) }),
]);

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, reason: "UNAUTHENTICATED" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, reason: "INVALID_PAYLOAD" }, { status: 400 });
  }
  const body = parsed.data;

  const { allowed } = await checkRateLimit(`wallet-transfer-resolve:${session.user.id}`, {
    limit: 20,
    windowMs: 60 * 1000,
  });
  if (!allowed) {
    return NextResponse.json({ ok: false, reason: "RATE_LIMITED" }, { status: 429 });
  }

  const sender = await prisma.wallet.findUnique({ where: { id: body.senderWalletId }, select: { ownerUserId: true } });
  if (!sender || sender.ownerUserId !== session.user.id) {
    return NextResponse.json({ ok: false, reason: "FORBIDDEN" }, { status: 403 });
  }

  const lookup =
    body.method === "NFC"
      ? { method: "NFC" as const, nfcUid: body.nfcUid }
      : body.method === "CODE"
        ? { method: "CODE" as const, code: body.code }
        : { method: "PHONE" as const, phone: body.phone };
  const result = await resolveRecipient(body.senderWalletId, lookup);
  if (!result.ok) {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json(result);
}
