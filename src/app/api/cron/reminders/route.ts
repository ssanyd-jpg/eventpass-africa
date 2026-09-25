import { NextResponse } from "next/server";
import { sendEventReminders } from "@/lib/reminders";
import { runPendingTopupSweep } from "@/lib/pending-topups";

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

  // Session 35 — Vercel Hobby allows two crons and both slots are taken
  // (this one and /api/cron/waitlist), so the pending top-up sweep rides
  // along on this daily run instead of getting its own. It runs whether or
  // not the reminders job succeeded — a paid-but-uncredited top-up shouldn't
  // wait another day because an unrelated reminder send threw — and a sweep
  // failure never turns a successful reminders run into a 500.
  let remindersError: unknown = null;
  let result: Awaited<ReturnType<typeof sendEventReminders>> | null = null;
  try {
    result = await sendEventReminders();
  } catch (error) {
    remindersError = error;
  }

  let pendingTopups: Awaited<ReturnType<typeof runPendingTopupSweep>> | { ok: false; reason: string };
  try {
    pendingTopups = await runPendingTopupSweep();
  } catch (error) {
    console.error("[cron/reminders] pending top-up sweep failed", error);
    pendingTopups = { ok: false, reason: "SWEEP_FAILED" };
  }

  if (remindersError) throw remindersError;
  return NextResponse.json({ ...result, pendingTopups });
}
