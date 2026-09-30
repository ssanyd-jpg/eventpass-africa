import { NextResponse } from "next/server";
import { expireStaleWaitlistNotifications } from "@/lib/waitlist";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, reason: "UNAUTHORIZED" }, { status: 401 });
  }

  // Second layer behind CRON_SECRET — see /api/cron/reminders for why this
  // runs after, not before, the secret check.
  const { allowed } = await checkRateLimit(`cron:${clientIp(request)}`, { limit: 10, windowMs: 60 * 60 * 1000 });
  if (!allowed) {
    return NextResponse.json({ ok: false, reason: "RATE_LIMITED" }, { status: 429 });
  }

  const result = await expireStaleWaitlistNotifications();
  return NextResponse.json(result);
}
