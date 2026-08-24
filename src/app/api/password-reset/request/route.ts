import { NextResponse } from "next/server";
import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { sendNotification } from "@/lib/notifications";

const requestSchema = z.object({ email: z.string().email() });

export async function POST(request: Request) {
  const { allowed } = await checkRateLimit(`password-reset:${clientIp(request)}`, {
    limit: 5,
    windowMs: 10 * 60 * 1000,
  });
  // Always return the same generic response regardless of rate limit or
  // whether the email exists — never reveal which emails have accounts.
  const generic = NextResponse.json({ ok: true });
  if (!allowed) return generic;

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return generic;

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (!user) return generic;

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  await prisma.passwordResetToken.create({
    data: { tokenHash, userId: user.id, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });

  const resetUrl = `${process.env.NEXTAUTH_URL ?? ""}/reset-password/${rawToken}`;
  await sendNotification({
    type: "PASSWORD_RESET",
    channel: "EMAIL",
    recipient: user.email,
    subject: "Reset your EventPass Africa password",
    body: `Hi ${user.name}, reset your password here (expires in 1 hour): ${resetUrl}`,
  });

  return generic;
}
