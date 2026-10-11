import type { Prisma, PoolContribution, TicketPool } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getActivePaymentProvider } from "@/lib/payments";
import { verifyAirpayOrder } from "@/lib/payments/airpay";
import { sendNotification } from "@/lib/notifications";
import { formatCents, generateTicketCode } from "@/lib/format";

// Session 40 — "chama"-style group crowdfunding toward ONE ticket purchase
// (or a small same-type batch, see TicketPool.quantity), ahead of an event,
// instead of one buyer paying full price alone. See the TicketPool/
// PoolContribution model comments in prisma/schema.prisma for the full
// status-machine design; in short:
//
//   - A contribution is its own direct mobile-money charge straight into
//     TicketPool.raisedCents (initiatePoolContribution/
//     settlePoolContribution mirror handleTopupWallet/
//     handleCheckTopupStatus almost exactly) — never routed through the
//     contributor's personal event Wallet, so a contributor never needs one
//     for this event at all.
//   - Reaching the target converts the pool into a real Order (see
//     convertPoolToOrder) — deliberately NOT a call into handleSellTickets,
//     because that function prices TIERED types live at creation time and
//     never blocks on oversell (it flags NEEDS_REVIEW instead); a pool's
//     price is frozen at creation (see validateCanStartPool's FIXED-only
//     gate) and a stranger's crowdfunded ticket must never be handed out
//     against an oversold slot, so conversion does its own bounded-CAS
//     inventory claim and fails closed into a refund-everyone path instead.
//   - Falling short (EXPIRED) or failing to convert (CANCELLED, see
//     cancelReason) refunds every contributor via the EXISTING wallet
//     machinery: each contribution's amount becomes a POOL_REFUND
//     WalletTransaction on the contributor's own wallet for that event
//     (auto-created via findOrCreateWalletForRefund if they never
//     registered one), which they can then spend at the event or withdraw
//     for real money through the existing organizer-approved withdrawal
//     flow — deliberately not inventing a new disbursement mechanism.
//   - A pool-converted Order's providerReference/airpayRef stay null: the
//     order is backed by N independent contributor charges, not one
//     reversible AirPay reference, so nothing must ever be able to resolve
//     a single contributor's bank reversing their STK push back onto the
//     recipient's whole ticket (see payment-reversal.ts).
//
// No Hobby-plan cron slot to spare for pool expiry either (same constraint
// wallet-transfer.ts's expireTransfers() header comment explains) — see
// expirePoolsOpportunistically below for the cheap inline status flip, and
// runPoolRefundSweep for the actual money-moving refund step, which rides
// the existing /api/cron/reminders run rather than getting its own slot.

export type PoolFailureReason =
  | "TICKET_TYPE_NOT_FOUND"
  | "TIERED_NOT_SUPPORTED"
  | "EVENT_NOT_LIVE"
  | "RECIPIENT_NOT_FOUND"
  | "INVALID_QUANTITY"
  | "INVALID_EXPIRY"
  | "POOL_NOT_FOUND"
  | "POOL_NOT_OPEN"
  | "POOL_EXPIRED"
  | "AMOUNT_INVALID"
  | "AMOUNT_EXCEEDS_REMAINING"
  | "CONTRIBUTION_NOT_FOUND"
  | "FORBIDDEN";

type Failure = { ok: false; reason: PoolFailureReason };
const fail = (reason: PoolFailureReason): Failure => ({ ok: false, reason });

const MIN_QUANTITY = 1;
const MAX_QUANTITY = 20;
const MAX_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;

// Thrown inside convertPoolToOrder's $transaction purely to roll it back;
// caught at the call site and turned into a result — same idiom as
// wallet-transfer.ts's TransferAbort.
class PoolConvertAbort extends Error {
  constructor(readonly reason: "SOLD_OUT" | "ALREADY_RESOLVED") {
    super(reason);
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (error as { code?: string })?.code === "P2002";
}

// ---------- start a pool ----------

export async function validateCanStartPool(ticketTypeId: string) {
  const ticketType = await prisma.ticketType.findUnique({
    where: { id: ticketTypeId },
    include: { event: { select: { id: true, status: true, currency: true, title: true, whatsappGroupEnabled: true } } },
  });
  if (!ticketType) return fail("TICKET_TYPE_NOT_FOUND");
  // v1 scope cut — see this file's header comment. TIERED pricing is
  // computed live at order-creation time elsewhere in the app; a pool's
  // targetCents is frozen at creation and never recomputed, so a TIERED
  // type's price climbing while the pool fills could under-raise what the
  // ticket actually costs by the time it converts.
  if (ticketType.pricingStrategy !== "FIXED") return fail("TIERED_NOT_SUPPORTED");
  if (ticketType.event.status !== "LIVE") return fail("EVENT_NOT_LIVE");
  return { ok: true as const, ticketType };
}

export interface StartPoolInput {
  clientId: string;
  ticketTypeId: string;
  creatorUserId: string;
  recipientUserId: string;
  quantity?: number;
  name?: string | null;
  expiresAt: Date;
}

export async function startPool(input: StartPoolInput): Promise<{ ok: true; pool: TicketPool } | Failure> {
  const existing = await prisma.ticketPool.findUnique({ where: { clientId: input.clientId } });
  if (existing) return { ok: true, pool: existing };

  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < MIN_QUANTITY || quantity > MAX_QUANTITY) return fail("INVALID_QUANTITY");

  const now = new Date();
  if (input.expiresAt <= now || input.expiresAt.getTime() - now.getTime() > MAX_EXPIRY_MS) return fail("INVALID_EXPIRY");

  const validated = await validateCanStartPool(input.ticketTypeId);
  if (!validated.ok) return validated;

  const recipient = await prisma.user.findUnique({ where: { id: input.recipientUserId }, select: { id: true } });
  if (!recipient) return fail("RECIPIENT_NOT_FOUND");

  const pool = await prisma.ticketPool.create({
    data: {
      clientId: input.clientId,
      name: input.name?.trim() || null,
      targetCents: validated.ticketType.priceCents * quantity,
      currency: validated.ticketType.event.currency,
      quantity,
      expiresAt: input.expiresAt,
      eventId: validated.ticketType.event.id,
      ticketTypeId: validated.ticketType.id,
      creatorUserId: input.creatorUserId,
      recipientUserId: input.recipientUserId,
    },
  });
  return { ok: true, pool };
}

export async function cancelPool(poolId: string, requestedByUserId: string) {
  const pool = await prisma.ticketPool.findUnique({ where: { id: poolId } });
  if (!pool) return fail("POOL_NOT_FOUND");
  if (pool.creatorUserId !== requestedByUserId) return fail("FORBIDDEN");
  if (pool.status !== "OPEN") return fail("POOL_NOT_OPEN");
  return cancelPoolAndRefundAll(poolId, "CREATOR_CANCELLED");
}

// ---------- expiry (no money movement) ----------

// Cheap status flip only, called inline wherever a pool is read or written
// — exact mirror of wallet-transfer.ts's expireTransfers(). The actual
// refund (money movement) only happens via runPoolRefundSweep, since that
// needs to run even if nobody ever opens the pool again.
export async function expirePoolsOpportunistically(now: Date = new Date()): Promise<number> {
  const res = await prisma.ticketPool.updateMany({
    where: { status: "OPEN", expiresAt: { lte: now } },
    data: { status: "EXPIRED" },
  });
  return res.count;
}

// ---------- contribute ----------

export interface InitiateContributionInput {
  poolId: string;
  contributorUserId: string;
  amountCents: number;
  phoneNumber?: string;
  mobileNetwork?: string;
  clientId: string;
}

export async function initiatePoolContribution(
  input: InitiateContributionInput
): Promise<{ ok: true; contribution: PoolContribution; replayed: boolean; converted: boolean } | Failure> {
  const replay = await prisma.poolContribution.findUnique({ where: { clientId: input.clientId } });
  // Whether the pool converted as a *result* of this specific contribution
  // isn't recoverable from the contribution row alone on a replay — the
  // caller should re-fetch the pool itself rather than rely on this flag.
  if (replay) return { ok: true, contribution: replay, replayed: true, converted: false };

  await expirePoolsOpportunistically();

  const pool = await prisma.ticketPool.findUnique({ where: { id: input.poolId } });
  if (!pool) return fail("POOL_NOT_FOUND");
  if (pool.status === "EXPIRED" || pool.expiresAt <= new Date()) return fail("POOL_EXPIRED");
  if (pool.status !== "OPEN") return fail("POOL_NOT_OPEN");

  const amountCents = Math.trunc(input.amountCents);
  if (!Number.isInteger(amountCents) || amountCents <= 0) return fail("AMOUNT_INVALID");
  // Early UX-level rejection only — raisedCents only moves on settlement,
  // not here, so this cannot by itself prevent two concurrent contributions
  // from both passing this check against the same stale `remaining`. The
  // real guard is the bounded CAS in settlePoolContribution below; a
  // contribution that loses that race has already captured real money and
  // gets refunded immediately rather than left stranded.
  const remaining = pool.targetCents - pool.raisedCents;
  if (amountCents > remaining) return fail("AMOUNT_EXCEEDS_REMAINING");

  const provider = getActivePaymentProvider();
  const charge = await provider.initiateCharge({
    orderClientId: input.clientId,
    amountCents,
    phoneNumber: input.phoneNumber,
    mobileNetwork: input.mobileNetwork,
    description: `Ticket pool contribution — ${pool.name ?? "Chaap"}`,
  });

  const baseData = {
    clientId: input.clientId,
    amountCents,
    currency: pool.currency,
    providerReference: charge.reference || null,
    providerMessage: charge.message ?? null,
    phoneNumber: input.phoneNumber ?? null,
    mobileNetwork: input.mobileNetwork ?? null,
    poolId: pool.id,
    contributorUserId: input.contributorUserId,
  };

  if (charge.status === "PAID") {
    // Instant-PAID (the simulator, same as handleTopupWallet's own
    // instant-PAID branch): create the contribution as COMPLETED directly
    // rather than routing it through settlePoolContribution, which would
    // wrongly call verifyAirpayOrder (an AirPay-specific endpoint) against
    // a simulated reference that AirPay has never heard of.
    const contribution = await prisma.poolContribution.create({
      data: { ...baseData, status: "COMPLETED", airpayRef: charge.reference || null },
    });
    const { converted } = await finishCompletedContribution(contribution);
    const fresh = await prisma.poolContribution.findUniqueOrThrow({ where: { id: contribution.id } });
    return { ok: true, contribution: fresh, replayed: false, converted };
  }

  const contribution = await prisma.poolContribution.create({
    data: { ...baseData, status: charge.status === "PENDING" ? "PENDING" : "FAILED" },
  });
  return { ok: true, contribution, replayed: false, converted: false };
}

// Mirrors handleCheckTopupStatus/processPendingTopup's CAS-on-status
// resolution exactly. Called from a client poll, and from the cron sweep's
// cousin pass for USSD-style payers who never reopen the app.
export async function settlePoolContribution(
  contributionId: string
): Promise<{ ok: true; contribution: PoolContribution; converted: boolean; overfunded: boolean } | Failure> {
  const contribution = await prisma.poolContribution.findUnique({ where: { id: contributionId } });
  if (!contribution) return fail("CONTRIBUTION_NOT_FOUND");
  if (contribution.status !== "PENDING") return { ok: true, contribution, converted: false, overfunded: false };
  if (!contribution.providerReference) return { ok: true, contribution, converted: false, overfunded: false };

  const result = await verifyAirpayOrder(contribution.providerReference);

  if (result.status === "PENDING") return { ok: true, contribution, converted: false, overfunded: false };

  if (result.status === "FAILED") {
    await prisma.poolContribution.updateMany({
      where: { id: contribution.id, status: "PENDING" },
      data: { status: "FAILED", providerMessage: result.message ?? null },
    });
    const fresh = await prisma.poolContribution.findUniqueOrThrow({ where: { id: contribution.id } });
    return { ok: true, contribution: fresh, converted: false, overfunded: false };
  }

  // PAID — compare-and-swap on status so a racing auto-check and a manual
  // "check status" click (or an overlapping sweep run) can't both credit
  // the pool, same discipline as handleCheckTopupStatus.
  const claimed = await prisma.poolContribution.updateMany({
    where: { id: contribution.id, status: "PENDING" },
    data: { status: "COMPLETED", airpayRef: result.reference || null, providerMessage: result.message ?? null },
  });
  if (claimed.count === 0) {
    // Already resolved by a concurrent call — fetch fresh and return it.
    const fresh = await prisma.poolContribution.findUniqueOrThrow({ where: { id: contribution.id } });
    return { ok: true, contribution: fresh, converted: false, overfunded: false };
  }

  const settled = await prisma.poolContribution.findUniqueOrThrow({ where: { id: contribution.id } });
  const { overfunded, converted } = await finishCompletedContribution(settled);
  const fresh = await prisma.poolContribution.findUniqueOrThrow({ where: { id: contribution.id } });
  return { ok: true, contribution: fresh, converted, overfunded };
}

// Shared by both PAID paths above (instant and poll/sweep-resolved) once a
// contribution is already COMPLETED: credit the pool with a bounded CAS
// (the overfunding-race guard — see this file's header comment), flip to
// FUNDED and attempt conversion if that credit reaches the target, and
// refund this one contribution immediately if the bound was lost to a
// concurrent settlement instead.
async function finishCompletedContribution(contribution: PoolContribution): Promise<{ overfunded: boolean; converted: boolean }> {
  let flippedToFunded = false;
  const credited = await prisma.$transaction(
    async (tx) => {
      // Prisma can't compare one column against another inside a WHERE, so
      // the bound (targetCents - amountCents) is computed from a fresh read
      // rather than inlined directly into the updateMany below.
      const pool = await tx.ticketPool.findUniqueOrThrow({ where: { id: contribution.poolId } });
      const creditRes = await tx.ticketPool.updateMany({
        where: { id: pool.id, status: "OPEN", raisedCents: { lte: pool.targetCents - contribution.amountCents } },
        data: { raisedCents: { increment: contribution.amountCents } },
      });
      if (creditRes.count === 0) return false;

      const freshPool = await tx.ticketPool.findUniqueOrThrow({ where: { id: pool.id } });
      if (freshPool.raisedCents >= freshPool.targetCents) {
        const flipped = await tx.ticketPool.updateMany({ where: { id: pool.id, status: "OPEN" }, data: { status: "FUNDED" } });
        flippedToFunded = flipped.count > 0;
      }
      return true;
    },
    { timeout: 15000, maxWait: 10000 }
  );

  if (!credited) {
    // Lost the race for the last bit of headroom — this contribution's
    // charge already captured real money, so it gets refunded immediately
    // rather than left stranded as a COMPLETED row the pool never counted.
    await refundContribution(contribution.id);
    return { overfunded: true, converted: false };
  }

  notifyRecipientOfContribution(contribution.poolId, contribution.amountCents).catch((error) => {
    console.error("[ticket-pool] contribution-received notification failed", contribution.id, error);
  });

  if (!flippedToFunded) return { overfunded: false, converted: false };

  try {
    await convertPoolToOrder(contribution.poolId);
    return { overfunded: false, converted: true };
  } catch (error) {
    if (error instanceof PoolConvertAbort && error.reason === "SOLD_OUT") {
      await cancelPoolAndRefundAll(contribution.poolId, "SOLD_OUT_AT_CONVERSION");
      return { overfunded: false, converted: false };
    }
    if (error instanceof PoolConvertAbort && error.reason === "ALREADY_RESOLVED") {
      return { overfunded: false, converted: false };
    }
    throw error;
  }
}

// ---------- conversion ----------

async function convertPoolToOrder(poolId: string) {
  return prisma.$transaction(
    async (tx) => {
      const pool = await tx.ticketPool.findUniqueOrThrow({
        where: { id: poolId },
        include: { ticketType: true, event: { select: { whatsappGroupEnabled: true } } },
      });
      // Idempotent guard against a replayed/racing call — only the FUNDED
      // state is convertible; anything else means this already happened
      // (or was cancelled) and there's nothing to do.
      if (pool.status !== "FUNDED") throw new PoolConvertAbort("ALREADY_RESOLVED");

      // Bounded CAS inventory claim — deliberately NOT handleSellTickets'
      // read-then-write (which oversells and flags NEEDS_REVIEW instead of
      // ever rejecting). A stranger-crowdfunded ticket must not be handed
      // out against a slot that's actually sold out.
      const claimed = await tx.ticketType.updateMany({
        where: { id: pool.ticketTypeId, quantitySold: { lte: pool.ticketType.quantityTotal - pool.quantity } },
        data: { quantitySold: { increment: pool.quantity } },
      });
      if (claimed.count === 0) throw new PoolConvertAbort("SOLD_OUT");

      const order = await tx.order.create({
        data: {
          clientId: `pool-conversion:${pool.id}`,
          status: "PAID",
          totalCents: pool.targetCents,
          currency: pool.currency,
          paymentMethod: "POOL",
          userId: pool.recipientUserId,
          eventId: pool.eventId,
          items: {
            create: [{ ticketTypeId: pool.ticketTypeId, quantity: pool.quantity, unitPriceCents: pool.ticketType.priceCents }],
          },
          tickets: {
            create: Array.from({ length: pool.quantity }, () => ({
              code: generateTicketCode(),
              eventId: pool.eventId,
              ticketTypeId: pool.ticketTypeId,
              whatsappGroupOptedIn: pool.event.whatsappGroupEnabled,
            })),
          },
        },
      });

      await tx.ticketPool.update({ where: { id: pool.id }, data: { status: "CONVERTED", resultingOrderId: order.id } });
      return { pool, order };
    },
    { timeout: 15000, maxWait: 10000 }
  ).then(async ({ pool, order }) => {
    await notifyPoolFunded(pool.id).catch((error) => {
      console.error("[ticket-pool] pool-funded notification failed", pool.id, error);
    });
    return { pool, order };
  });
}

// ---------- refund ----------

async function findOrCreateWalletForRefund(tx: Prisma.TransactionClient, eventId: string, userId: string, currency: string) {
  const existing = await tx.wallet.findUnique({ where: { eventId_ownerUserId: { eventId, ownerUserId: userId } } });
  if (existing) return existing;
  try {
    return await tx.wallet.create({ data: { code: generateTicketCode(), eventId, ownerUserId: userId, currency } });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return tx.wallet.findUniqueOrThrow({ where: { eventId_ownerUserId: { eventId, ownerUserId: userId } } });
    }
    throw error;
  }
}

// CAS COMPLETED->REFUNDED, same res.count===0 double-refund guard as
// handleRejectWithdrawal. Idempotent — safe to call more than once for the
// same contribution (the sweep, a retried request, and the overfunding-race
// path in settlePoolContribution above can all reach this).
export async function refundContribution(contributionId: string) {
  const result = await prisma.$transaction(
    async (tx) => {
      const claimed = await tx.poolContribution.updateMany({
        where: { id: contributionId, status: "COMPLETED" },
        data: { status: "REFUNDED" },
      });
      if (claimed.count === 0) return null;

      const contribution = await tx.poolContribution.findUniqueOrThrow({
        where: { id: contributionId },
        include: { pool: { select: { eventId: true, currency: true, name: true } } },
      });
      const wallet = await findOrCreateWalletForRefund(tx, contribution.pool.eventId, contribution.contributorUserId, contribution.pool.currency);
      const refundTx = await tx.walletTransaction.create({
        data: {
          type: "POOL_REFUND",
          status: "COMPLETED",
          amountCents: contribution.amountCents,
          currency: contribution.pool.currency,
          walletId: wallet.id,
          note: contribution.pool.name ?? "Ticket pool",
        },
      });
      await tx.wallet.update({ where: { id: wallet.id }, data: { balanceCents: { increment: contribution.amountCents } } });
      await tx.poolContribution.update({ where: { id: contributionId }, data: { refundTransactionId: refundTx.id } });

      const contributor = await tx.user.findUnique({ where: { id: contribution.contributorUserId }, select: { phone: true } });
      return { contribution, walletBalanceCents: wallet.balanceCents + contribution.amountCents, contributorPhone: contributor?.phone ?? null };
    },
    { timeout: 15000, maxWait: 10000 }
  );

  if (!result) return { ok: true as const, alreadyRefunded: true };

  // Best-effort, after commit — money has already moved, same stance as
  // every other post-commit notification in this codebase.
  if (result.contributorPhone) {
    try {
      await sendNotification({
        type: "POOL_REFUNDED",
        channel: "WHATSAPP",
        recipient: result.contributorPhone,
        subject: "Ticket pool refunded",
        body: `Your contribution of ${formatCents(result.contribution.amountCents, result.contribution.currency)} has been refunded to your Chaap wallet for this event. New balance: ${formatCents(result.walletBalanceCents, result.contribution.currency)}.`,
      });
    } catch (error) {
      console.error("[ticket-pool] refund notification failed", contributionId, error);
    }
  }

  return { ok: true as const, alreadyRefunded: false };
}

// CAS OPEN|FUNDED -> CANCELLED, then refunds every COMPLETED contribution.
// Used both for the sold-out-at-conversion path and for a creator cancelling
// early.
async function cancelPoolAndRefundAll(poolId: string, cancelReason: "SOLD_OUT_AT_CONVERSION" | "CREATOR_CANCELLED") {
  const claimed = await prisma.ticketPool.updateMany({
    where: { id: poolId, status: { in: ["OPEN", "FUNDED"] } },
    data: { status: "CANCELLED", cancelReason },
  });
  if (claimed.count === 0) return { ok: true as const, alreadyTerminal: true, refundedCount: 0 };

  const completed = await prisma.poolContribution.findMany({ where: { poolId, status: "COMPLETED" }, select: { id: true } });
  let refundedCount = 0;
  for (const { id } of completed) {
    const outcome = await refundContribution(id);
    if (!outcome.alreadyRefunded) refundedCount++;
  }

  if (cancelReason === "SOLD_OUT_AT_CONVERSION") {
    await notifyPoolSoldOut(poolId).catch((error) => {
      console.error("[ticket-pool] sold-out notification failed", poolId, error);
    });
  }

  return { ok: true as const, alreadyTerminal: false, refundedCount };
}

// ---------- cron sweep ----------

const SWEEP_CONCURRENCY = 5;

export interface PoolRefundSweepResult {
  ok: true;
  expired: number;
  processed: number;
  refunded: number;
}

// Rides the existing /api/cron/reminders run rather than its own Vercel Hobby
// cron slot (see this file's header comment). Idempotent: refundContribution
// only ever moves a row off COMPLETED once (CAS), so re-running only ever
// touches what's still outstanding.
export async function runPoolRefundSweep(now: Date = new Date()): Promise<PoolRefundSweepResult> {
  const expired = await expirePoolsOpportunistically(now);

  const toRefund = await prisma.poolContribution.findMany({
    where: { status: "COMPLETED", pool: { status: { in: ["EXPIRED", "CANCELLED"] } } },
    select: { id: true },
  });

  let refunded = 0;
  for (let i = 0; i < toRefund.length; i += SWEEP_CONCURRENCY) {
    const batch = toRefund.slice(i, i + SWEEP_CONCURRENCY);
    const outcomes = await Promise.all(
      batch.map(async ({ id }) => {
        try {
          const outcome = await refundContribution(id);
          return !outcome.alreadyRefunded;
        } catch (error) {
          console.error("[ticket-pool] refund sweep could not resolve contribution", id, error);
          return false;
        }
      })
    );
    refunded += outcomes.filter(Boolean).length;
  }

  return { ok: true, expired, processed: toRefund.length, refunded };
}

// ---------- notifications ----------

async function notifyRecipientOfContribution(poolId: string, amountCents: number) {
  const pool = await prisma.ticketPool.findUnique({
    where: { id: poolId },
    select: { currency: true, targetCents: true, raisedCents: true, recipient: { select: { phone: true } } },
  });
  if (!pool?.recipient.phone) return;
  await sendNotification({
    type: "POOL_CONTRIBUTION_RECEIVED",
    channel: "WHATSAPP",
    recipient: pool.recipient.phone,
    subject: "Ticket pool contribution received",
    body: `Your ticket pool just received ${formatCents(amountCents, pool.currency)} — ${formatCents(pool.raisedCents, pool.currency)} of ${formatCents(pool.targetCents, pool.currency)} raised so far.`,
  });
}

async function notifyPoolFunded(poolId: string) {
  const pool = await prisma.ticketPool.findUnique({
    where: { id: poolId },
    include: {
      recipient: { select: { phone: true } },
      contributions: { where: { status: "COMPLETED" }, select: { contributorUserId: true } },
    },
  });
  if (!pool) return;

  const contributorIds = Array.from(new Set(pool.contributions.map((c) => c.contributorUserId)));
  const contributors = await prisma.user.findMany({ where: { id: { in: contributorIds } }, select: { id: true, phone: true } });

  const recipients = [pool.recipient.phone, ...contributors.map((c) => c.phone)].filter((p): p is string => !!p);
  for (const phone of Array.from(new Set(recipients))) {
    try {
      await sendNotification({
        type: "POOL_FUNDED",
        channel: "WHATSAPP",
        recipient: phone,
        subject: "Ticket pool funded!",
        body: `"${pool.name ?? "Your ticket pool"}" reached its goal — the ticket has been booked. 🎉`,
      });
    } catch (error) {
      console.error("[ticket-pool] pool-funded notification failed", poolId, phone, error);
    }
  }
}

async function notifyPoolSoldOut(poolId: string) {
  const pool = await prisma.ticketPool.findUnique({ where: { id: poolId }, include: { recipient: { select: { phone: true } } } });
  if (!pool?.recipient.phone) return;
  await sendNotification({
    type: "POOL_SOLD_OUT_REFUNDED",
    channel: "WHATSAPP",
    recipient: pool.recipient.phone,
    subject: "Ticket pool refunded — sold out",
    body: `"${pool.name ?? "Your ticket pool"}" reached its goal, but that ticket type sold out before it could be booked. Every contribution has been refunded to each person's Chaap wallet for this event.`,
  });
}

// ---------- organiser analytics ----------

export interface PoolActivitySummary {
  poolCount: number;
  convertedCount: number;
  // Partitioned by currency, same discipline as every other volume figure
  // in analytics.ts/wallet-transfer.ts's summarizeTransferVolume — a single
  // summed total would silently conflate pools raised in different
  // currencies.
  raisedByCurrency: Record<string, number>;
}

// Pure, DB-free, same shape as summarizeGroupSales in ticket-groups.ts.
export function summarizePoolActivity(pools: { status: string; raisedCents: number; currency: string }[]): PoolActivitySummary {
  const raisedByCurrency: Record<string, number> = {};
  for (const p of pools) {
    raisedByCurrency[p.currency] = (raisedByCurrency[p.currency] ?? 0) + p.raisedCents;
  }
  return {
    poolCount: pools.length,
    convertedCount: pools.filter((p) => p.status === "CONVERTED").length,
    raisedByCurrency,
  };
}
