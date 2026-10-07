import { NextResponse } from "next/server";
import { sendEventReminders } from "@/lib/reminders";
import { runPendingTopupSweep } from "@/lib/pending-topups";
import { runSeasonRenewalSweep } from "@/lib/season-renewal";
import { runWhatsappGroupArchiveSweep } from "@/lib/whatsapp-group";
import { runWaitlistClosureSweep } from "@/lib/waitlist";
import { runWalletTopupReminderSweep } from "@/lib/wallet-topup-reminder";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";

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

  // Second layer behind CRON_SECRET: even a correctly-authenticated caller
  // (e.g. a leaked secret, or Vercel misfiring) shouldn't be able to
  // trigger an unbounded number of sends/sweeps back to back. Deliberately
  // checked AFTER the secret gate, not before — an anonymous flood should
  // cost nothing more than the cheap string comparison above, not a DB
  // round trip.
  const { allowed } = await checkRateLimit(`cron:${clientIp(request)}`, { limit: 10, windowMs: 60 * 60 * 1000 });
  if (!allowed) {
    return NextResponse.json({ ok: false, reason: "RATE_LIMITED" }, { status: 429 });
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

  // Season pass auto-renewal offers — same "rides along on this one daily
  // slot" reasoning as the pending top-up sweep above (Hobby plan, both
  // cron slots already taken). Independent of both other sweeps' outcomes.
  let seasonRenewal: Awaited<ReturnType<typeof runSeasonRenewalSweep>> | { ok: false; reason: string };
  try {
    seasonRenewal = await runSeasonRenewalSweep();
  } catch (error) {
    console.error("[cron/reminders] season renewal sweep failed", error);
    seasonRenewal = { ok: false, reason: "SWEEP_FAILED" };
  }

  // Event WhatsApp group archive sweep — same "rides along on this one
  // daily slot" reasoning as the pending top-up/season renewal sweeps
  // above (Vercel Hobby, both cron slots already taken).
  let whatsappGroupArchive: Awaited<ReturnType<typeof runWhatsappGroupArchiveSweep>> | { ok: false; reason: string };
  try {
    whatsappGroupArchive = await runWhatsappGroupArchiveSweep();
  } catch (error) {
    console.error("[cron/reminders] whatsapp group archive sweep failed", error);
    whatsappGroupArchive = { ok: false, reason: "SWEEP_FAILED" };
  }

  // Waitlist closure sweep — same "rides along on this one daily slot"
  // reasoning as the sweeps above. Immediate cancellations already get
  // their closure message straight from handleCancelEvent; this only
  // catches an event that simply ended with attendees still WAITING.
  let waitlistClosure: Awaited<ReturnType<typeof runWaitlistClosureSweep>> | { ok: false; reason: string };
  try {
    waitlistClosure = await runWaitlistClosureSweep();
  } catch (error) {
    console.error("[cron/reminders] waitlist closure sweep failed", error);
    waitlistClosure = { ok: false, reason: "SWEEP_FAILED" };
  }

  // Pre-event wallet top-up reminder sweep — same "rides along on this one
  // daily slot" reasoning as the sweeps above.
  let walletTopupReminder: Awaited<ReturnType<typeof runWalletTopupReminderSweep>> | { ok: false; reason: string };
  try {
    walletTopupReminder = await runWalletTopupReminderSweep();
  } catch (error) {
    console.error("[cron/reminders] wallet top-up reminder sweep failed", error);
    walletTopupReminder = { ok: false, reason: "SWEEP_FAILED" };
  }

  if (remindersError) throw remindersError;
  return NextResponse.json({ ...result, pendingTopups, seasonRenewal, whatsappGroupArchive, waitlistClosure, walletTopupReminder });
}
