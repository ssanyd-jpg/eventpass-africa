import { NextResponse } from "next/server";
import { sendEventReminders } from "@/lib/reminders";

// Vercel Cron (see vercel.json's schedule) hits this with an
// `Authorization: Bearer ${CRON_SECRET}` header it adds automatically for
// any route under /api/cron — see
// https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs.
// No CRON_SECRET set means nobody (not even Vercel) can trigger this route,
// same "missing config, err on the side of closed" call as every other
// optional-provider gate in this codebase — this one just fails the
// request instead of falling back to a log, since there's no safe
// unauthenticated fallback for triggering a mass send.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, reason: "UNAUTHORIZED" }, { status: 401 });
  }

  const result = await sendEventReminders();
  return NextResponse.json(result);
}
