import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { verifyAirpayOrder } from "@/lib/payments/airpay";
import { sendNotification } from "@/lib/notifications";
import { formatCents } from "@/lib/format";

// Session 35 — a wallet top-up (USSD or in-app) is only ever credited when
// something polls verifyAirpayOrder: handleCheckTopupStatus, driven by the
// app's own polling loop. A USSD user who pays on their phone and never
// opens the app therefore has a PENDING row that nothing resolves — they paid
// and their balance never moves. This sweep is that missing poller, run from
// Vercel Cron (see DEPLOYMENT.md §9 for which cron slot it rides on).
//
// Terminal statuses are this codebase's own — COMPLETED / FAILED, not
// "CONFIRMED" — because USSD's last-transaction screen and the AirPay
// reconciliation report both key off COMPLETED.

// A top-up still PENDING after a day is assumed abandoned (the M-Pesa prompt
// expired unanswered) and is left alone rather than polled forever.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Bounded parallelism: enough to stay inside a serverless function's time
// budget when a batch has built up, few enough not to exhaust Neon's pooler.
const CONCURRENCY = 5;

const pendingTopupInclude = {
  wallet: { select: { id: true, currency: true, owner: { select: { phone: true } } } },
} satisfies Prisma.WalletTransactionInclude;

export type PendingTopup = Prisma.WalletTransactionGetPayload<{ include: typeof pendingTopupInclude }>;

export type PendingTopupOutcome = "CONFIRMED" | "FAILED" | "PENDING" | "ALREADY_RESOLVED";

export interface PendingTopupSweepResult {
  ok: true;
  processed: number;
  confirmed: number;
  failed: number;
  stillPending: number;
  // Resolved by a concurrent app poll between the query and our own
  // compare-and-swap — counted separately so it isn't reported as this
  // sweep's own confirmation.
  alreadyResolved: number;
}

export async function getPendingTopups(now: Date = new Date()): Promise<PendingTopup[]> {
  return prisma.walletTransaction.findMany({
    where: {
      type: "TOPUP",
      status: "PENDING",
      createdAt: { gt: new Date(now.getTime() - MAX_AGE_MS) },
    },
    include: pendingTopupInclude,
    orderBy: { createdAt: "asc" },
  });
}

export async function processPendingTopup(transaction: PendingTopup): Promise<PendingTopupOutcome> {
  // No merchant order id means there is nothing to ask AirPay about.
  if (!transaction.providerReference) return "PENDING";

  const result = await verifyAirpayOrder(transaction.providerReference);
  if (result.status === "PENDING") return "PENDING";

  if (result.status === "FAILED") {
    const res = await prisma.walletTransaction.updateMany({
      where: { id: transaction.id, status: "PENDING" },
      data: { status: "FAILED", providerMessage: result.message ?? null },
    });
    return res.count > 0 ? "FAILED" : "ALREADY_RESOLVED";
  }

  // PAID. Compare-and-swap on status, same as handleCheckTopupStatus, so a
  // sweep racing the app's own poll (or an overlapping sweep) can't credit
  // the balance twice.
  const amountCents = transaction.amountCents ?? 0;
  const credited = await prisma.$transaction(
    async (dbTx) => {
      const res = await dbTx.walletTransaction.updateMany({
        where: { id: transaction.id, status: "PENDING" },
        data: { status: "COMPLETED", providerMessage: result.message ?? null, airpayRef: result.reference || null },
      });
      if (res.count === 0) return null;
      return dbTx.wallet.update({
        where: { id: transaction.walletId },
        data: { balanceCents: { increment: amountCents } },
        select: { balanceCents: true, currency: true, owner: { select: { phone: true } } },
      });
    },
    { timeout: 15000, maxWait: 10000 }
  );
  if (!credited) return "ALREADY_RESOLVED";

  // Best-effort and only for the call that actually made the transition. The
  // money is already credited; a failed notification must not turn that into
  // an error.
  if (credited.owner.phone) {
    try {
      await sendNotification({
        type: "WALLET_TOPUP_CONFIRMED",
        channel: "WHATSAPP",
        recipient: credited.owner.phone,
        subject: "Top-up confirmed",
        body: `Your top-up of ${formatCents(amountCents, credited.currency)} has been confirmed — your new balance is ${formatCents(credited.balanceCents, credited.currency)}`,
      });
    } catch (error) {
      console.error("[pending-topups] confirmation notification failed", transaction.id, error);
    }
  }
  return "CONFIRMED";
}

// Idempotent: a row leaves PENDING exactly once (CAS above), and anything
// already resolved is filtered out by getPendingTopups, so re-running only
// ever touches what is still outstanding.
export async function runPendingTopupSweep(now: Date = new Date()): Promise<PendingTopupSweepResult> {
  const pending = await getPendingTopups(now);
  const tally: PendingTopupSweepResult = {
    ok: true,
    processed: pending.length,
    confirmed: 0,
    failed: 0,
    stillPending: 0,
    alreadyResolved: 0,
  };

  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const batch = pending.slice(i, i + CONCURRENCY);
    const outcomes = await Promise.all(
      batch.map(async (transaction): Promise<PendingTopupOutcome> => {
        try {
          return await processPendingTopup(transaction);
        } catch (error) {
          // AirPay unreachable / credentials missing: one bad lookup must not
          // abort the rest of the sweep. Left PENDING for the next run.
          console.error("[pending-topups] could not resolve top-up", transaction.id, error);
          return "PENDING";
        }
      })
    );
    for (const outcome of outcomes) {
      if (outcome === "CONFIRMED") tally.confirmed++;
      else if (outcome === "FAILED") tally.failed++;
      else if (outcome === "ALREADY_RESOLVED") tally.alreadyResolved++;
      else tally.stillPending++;
    }
  }

  return tally;
}
