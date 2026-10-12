import { NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { normalizeTanzaniaPhone } from "@/lib/sms";
import { generateAndSendPhoneCode } from "@/lib/phone-otp";

// Public, unauthenticated — this is how an anonymous checkout buyer starts
// inline phone-OTP signup (see EventDetailClient.tsx). Takes only `phone`,
// not name/email too, to keep this route minimal; a later email collision
// is caught at verify-time instead, inside the "buyer-otp" provider in
// auth.ts. Unlike password-reset/request's deliberate anti-enumeration
// generic response, this can return real errors directly — there's no
// "does this phone have an account" secret to protect, the caller is
// proving control of their own number, not probing someone else's.
const bodySchema = z.object({ phone: z.string().min(6).max(20) });

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a valid phone number." }, { status: 400 });
  }

  const phone = normalizeTanzaniaPhone(parsed.data.phone);
  const ip = clientIp(request);

  const [ipOk, phoneOk] = await Promise.all([
    checkRateLimit(`otp-send-ip:${ip}`, { limit: 8, windowMs: 10 * 60 * 1000 }),
    checkRateLimit(`otp-send-phone:${phone}`, { limit: 5, windowMs: 60 * 60 * 1000 }),
  ]);
  if (!ipOk.allowed || !phoneOk.allowed) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }

  const result = await generateAndSendPhoneCode(phone);
  if (!result.ok) {
    return NextResponse.json({ error: "Please wait a moment before requesting another code." }, { status: 429 });
  }

  return NextResponse.json({ ok: true });
}
