import { NextResponse } from "next/server";
import { runPendingTopupSweep } from "@/lib/pending-topups";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";

// Same CRON_SECRET bearer gate as /api/cron/reminders and /api/cron/waitlist.
// This route is not in vercel.json: both Hobby-plan cron slots are taken, so
// the daily production run rides on /api/cron/reminders instead (see
// DEPLOYMENT.md §9). It stays a separate route so it can be triggered by hand
// and given its own per-minute schedule after a Vercel Pro upgrade.
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

  const result = await runPendingTopupSweep();
  return NextResponse.json(result);
}
