import { randomInt } from "crypto";
import type { WalletTransfer } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/notifications";
import { normalizeTanzaniaPhone } from "@/lib/sms";
import { formatCents } from "@/lib/format";
import { MIN_TRANSFER_CENTS, MAX_TRANSFER_CENTS, TRANSFER_EXPIRY_MS, TRANSFER_CURRENCY } from "@/lib/wallet-transfer-limits";

// Session 37 — peer-to-peer wallet transfers between wristband holders at the
// same event. See the WalletTransfer model's schema comment for the design;
// in short, a transfer is two-phase (initiate debits the sender, complete
// credits the recipient) so an interrupted transfer can never lose money —
// it expires after 15 minutes and refunds the sender.
//
// Structurally this follows ticket-transfer.ts (a PENDING row with an
// expiry, cancellation, a notification after commit) and sync-handlers.ts's
// wallet code (compare-and-swap on the balance / status, refund by marking
// the debit FAILED). Failures return { ok: false, reason } rather than
// throwing, same as the sync handlers, so the outbox can tell a permanent
// rejection from a retry.

export { MIN_TRANSFER_CENTS, MAX_TRANSFER_CENTS, TRANSFER_EXPIRY_MS };

export type TransferMethod = "NFC" | "CODE" | "PHONE";

export type TransferFailure =
  | "WALLET_NOT_FOUND"
  | "TRANSFERS_DISABLED"
  | "EVENT_NOT_LIVE"
  | "CURRENCY_NOT_SUPPORTED"
  | "SELF_TRANSFER"
  | "DIFFERENT_EVENT"
  | "AMOUNT_TOO_LOW"
  | "AMOUNT_TOO_HIGH"
  | "INSUFFICIENT_BALANCE"
  | "RECIPIENT_NOT_FOUND"
  | "INVALID_CODE"
  | "CODE_EXPIRED"
  | "TRANSFER_NOT_FOUND"
  | "TRANSFER_EXPIRED"
  | "TRANSFER_CANCELLED"
  | "NOT_CLAIMED"
  | "NOT_PENDING";

type Failure = { ok: false; reason: TransferFailure };
const fail = (reason: TransferFailure): Failure => ({ ok: false, reason });

export type RecipientLookup =
  | { method: "NFC"; nfcUid: string }
  | { method: "CODE"; code: string }
  | { method: "PHONE"; phone: string };

// First whitespace-separated word of a name — the only part of the other
// party's identity a transfer ever shows (confirmation screen, history,
// WhatsApp). "Someone" rather than an empty string for a nameless account.
export function firstNameOf(name: string | null | undefined): string {
  return name?.trim().split(/\s+/)[0] || "Someone";
}

const walletForTransferInclude = {
  event: { select: { id: true, status: true, currency: true, transferEnabled: true } },
  owner: { select: { id: true, name: true, phone: true } },
} as const;

async function loadWallet(walletId: string) {
  return prisma.wallet.findUnique({ where: { id: walletId }, include: walletForTransferInclude });
}
type LoadedWallet = NonNullable<Awaited<ReturnType<typeof loadWallet>>>;

// The event-level gates, shared by every entry point. Checked against the
// SENDER's event; a recipient in a different event is a separate
// DIFFERENT_EVENT failure.
function assertTransferable(wallet: LoadedWallet): TransferFailure | null {
  if (!wallet.event.transferEnabled) return "TRANSFERS_DISABLED";
  if (wallet.event.status !== "LIVE") return "EVENT_NOT_LIVE";
  if (wallet.currency !== TRANSFER_CURRENCY) return "CURRENCY_NOT_SUPPORTED";
  return null;
}

// Thrown inside a $transaction purely to roll it back (the debit must not
// survive a failed claim); caught at the call site and turned into a result.
class TransferAbort extends Error {
  constructor(readonly reason: TransferFailure) {
    super(reason);
  }
}

// ---------- organiser analytics ----------

export interface TransferVolumeStats {
  transferVolumeByCurrency: Record<string, number>;
  transferCount: number;
}

// Volume and count of COMPLETED peer-to-peer transfers, for the organiser's
// "Cashless wallets" analytics. Only the TRANSFER_OUT side is counted: every
// transfer writes exactly one OUT and one IN row, so summing both would
// double the figure. PENDING (not yet completed), FAILED (cancelled or
// expired, and refunded) rows moved no money between wallets and are
// excluded. Partitioned by currency like every other volume figure.
//
// Deliberately kept apart from summarizeWalletActivity: a transfer is money
// moving between attendees, not money entering (top-up) or leaving (spend)
// the event, so folding it into either total would misstate both.
export function summarizeTransferVolume(
  txs: { type: string; status: string; amountCents: number | null; currency: string }[]
): TransferVolumeStats {
  const transferVolumeByCurrency: Record<string, number> = {};
  let transferCount = 0;
  for (const t of txs) {
    if (t.type !== "TRANSFER_OUT" || t.status !== "COMPLETED") continue;
    transferVolumeByCurrency[t.currency] = (transferVolumeByCurrency[t.currency] ?? 0) + (t.amountCents ?? 0);
    transferCount += 1;
  }
  return { transferVolumeByCurrency, transferCount };
}

// ---------- expiry ----------

// Cancels or expires a PENDING transfer and gives the sender their money
// back. Compare-and-swap on status, so racing a concurrent complete/cancel
// resolves to exactly one winner. Returns false if someone else got there
// first.
async function reverseTransfer(transferId: string, finalStatus: "CANCELLED" | "EXPIRED"): Promise<boolean> {
  return prisma.$transaction(
    async (tx) => {
      const claimed = await tx.walletTransfer.updateMany({
        where: { id: transferId, status: "PENDING" },
        data: { status: finalStatus },
      });
      if (claimed.count === 0) return false;

      const transfer = await tx.walletTransfer.findUniqueOrThrow({ where: { id: transferId } });
      // An unclaimed code offer never debited anyone — nothing to reverse.
      if (transfer.senderWalletId && transfer.senderTransactionId && transfer.amountCents) {
        // Same shape as REJECT_WITHDRAWAL: the debit row is marked FAILED
        // (so no spend/volume figure counts it) and the balance re-credited.
        const reversed = await tx.walletTransaction.updateMany({
          where: { id: transfer.senderTransactionId, status: "PENDING" },
          data: {
            status: "FAILED",
            providerMessage: finalStatus === "EXPIRED" ? "Transfer expired" : "Transfer cancelled",
          },
        });
        if (reversed.count > 0) {
          await tx.wallet.update({
            where: { id: transfer.senderWalletId },
            data: { balanceCents: { increment: transfer.amountCents } },
          });
        }
      }
      return true;
    },
    { timeout: 15000, maxWait: 10000 }
  );
}

// Called at the start of every new transfer step rather than from a cron —
// there is no Hobby-plan cron slot to spare (see DEPLOYMENT.md §9), and a
// transfer that nobody touches again only holds the sender's money until the
// next transfer anywhere in the system, or their own next attempt.
export async function expireTransfers(now: Date = new Date()): Promise<number> {
  const stale = await prisma.walletTransfer.findMany({
    where: { status: "PENDING", expiresAt: { lte: now } },
    select: { id: true },
  });
  let expired = 0;
  for (const { id } of stale) {
    if (await reverseTransfer(id, "EXPIRED")) expired++;
  }
  return expired;
}

export async function cancelTransfer(transferId: string): Promise<{ ok: true; transfer: WalletTransfer } | Failure> {
  const transfer = await prisma.walletTransfer.findUnique({ where: { id: transferId } });
  if (!transfer) return fail("TRANSFER_NOT_FOUND");
  if (transfer.status !== "PENDING") return fail("NOT_PENDING");
  if (!(await reverseTransfer(transferId, "CANCELLED"))) return fail("NOT_PENDING");
  return { ok: true, transfer: await prisma.walletTransfer.findUniqueOrThrow({ where: { id: transferId } }) };
}

// ---------- Method B: the recipient's code ----------

const CODE_ATTEMPTS = 10;

export async function createReceiveCode(
  recipientWalletId: string,
  clientId: string,
  now: Date = new Date()
): Promise<{ ok: true; transferId: string; code: string; expiresAt: Date } | Failure> {
  const existing = await prisma.walletTransfer.findUnique({ where: { clientId } });
  if (existing?.transferCode) {
    return { ok: true, transferId: existing.id, code: existing.transferCode, expiresAt: existing.expiresAt };
  }

  await expireTransfers(now);

  const wallet = await loadWallet(recipientWalletId);
  if (!wallet) return fail("WALLET_NOT_FOUND");
  const blocked = assertTransferable(wallet);
  if (blocked) return fail(blocked);

  // One live code per wallet: asking for a new one retires the old one, so
  // the code space stays sparse and a stale code can't be claimed after the
  // recipient has moved on.
  await prisma.walletTransfer.updateMany({
    where: { recipientWalletId: wallet.id, status: "PENDING", senderWalletId: null },
    data: { status: "CANCELLED" },
  });

  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const clash = await prisma.walletTransfer.findFirst({
      where: { transferCode: code, status: "PENDING", expiresAt: { gt: now } },
      select: { id: true },
    });
    if (clash) continue;

    const created = await prisma.walletTransfer.create({
      data: {
        clientId,
        method: "CODE",
        status: "PENDING",
        currency: wallet.currency,
        transferCode: code,
        initiatedAt: now,
        expiresAt: new Date(now.getTime() + TRANSFER_EXPIRY_MS),
        recipientWalletId: wallet.id,
        eventId: wallet.eventId,
      },
    });
    return { ok: true, transferId: created.id, code, expiresAt: created.expiresAt };
  }
  // 10 collisions in a row against a 1,000,000-code space means something is
  // badly wrong; fail closed rather than hand out a duplicate.
  throw new Error("Could not allocate a unique transfer code");
}

// ---------- recipient resolution (all three methods) ----------

export interface ResolvedRecipient {
  walletId: string;
  firstName: string;
  // CODE only — the offer row the sender must claim in initiateTransfer.
  offerId?: string;
}

export async function resolveRecipient(
  senderWalletId: string,
  lookup: RecipientLookup,
  now: Date = new Date()
): Promise<{ ok: true; recipient: ResolvedRecipient } | Failure> {
  await expireTransfers(now);

  const sender = await loadWallet(senderWalletId);
  if (!sender) return fail("WALLET_NOT_FOUND");
  const blocked = assertTransferable(sender);
  if (blocked) return fail(blocked);

  let recipient: LoadedWallet | null = null;
  let offerId: string | undefined;

  if (lookup.method === "NFC") {
    // The sender's phone doesn't hold anyone else's credentials, so unlike
    // the staff terminals' client-side resolveCodeFromUid this is a server
    // lookup. Prefer the credential at the sender's own event: a tag can
    // carry a wallet credential per event, and only one of them is relevant.
    const uid = lookup.nfcUid.trim();
    const credentials = uid
      ? await prisma.credential.findMany({
          where: { nfcUid: uid, status: "ACTIVE", walletId: { not: null } },
          select: { walletId: true, wallet: { select: { eventId: true } } },
        })
      : [];
    const match = credentials.find((c) => c.wallet?.eventId === sender.eventId) ?? credentials[0];
    if (!match?.walletId) return fail("RECIPIENT_NOT_FOUND");
    recipient = await loadWallet(match.walletId);
  } else if (lookup.method === "PHONE") {
    const phone = normalizeTanzaniaPhone(lookup.phone);
    // Same event only, by construction — a number that has a wallet at some
    // other event is indistinguishable from one with no wallet, so this
    // lookup can't be used to probe who attends what.
    recipient = await prisma.wallet.findFirst({
      where: { eventId: sender.eventId, owner: { phone } },
      include: walletForTransferInclude,
    });
    if (!recipient) return fail("RECIPIENT_NOT_FOUND");
  } else {
    const code = lookup.code.replace(/\D/g, "");
    if (code.length !== 6) return fail("INVALID_CODE");
    const offer = await prisma.walletTransfer.findFirst({
      where: {
        transferCode: code,
        status: "PENDING",
        senderWalletId: null,
        expiresAt: { gt: now },
        eventId: sender.eventId,
      },
    });
    if (!offer) {
      const wasLive = await prisma.walletTransfer.findFirst({
        where: { transferCode: code, status: "EXPIRED", eventId: sender.eventId },
        select: { id: true },
      });
      return fail(wasLive ? "CODE_EXPIRED" : "INVALID_CODE");
    }
    offerId = offer.id;
    recipient = await loadWallet(offer.recipientWalletId);
  }

  if (!recipient) return fail("RECIPIENT_NOT_FOUND");
  if (recipient.id === sender.id || recipient.ownerUserId === sender.ownerUserId) return fail("SELF_TRANSFER");
  if (recipient.eventId !== sender.eventId) return fail("DIFFERENT_EVENT");

  return { ok: true, recipient: { walletId: recipient.id, firstName: firstNameOf(recipient.owner.name), offerId } };
}

// ---------- initiate / complete ----------

export interface InitiateOptions {
  // CODE only — the offer row resolveRecipient returned.
  offerId?: string;
  now?: Date;
}

export async function initiateTransfer(
  senderWalletId: string,
  recipientWalletId: string,
  amountCents: number,
  method: TransferMethod,
  clientId: string,
  options: InitiateOptions = {}
): Promise<{ ok: true; transfer: WalletTransfer; senderBalanceCents: number; replayed: boolean } | Failure> {
  const now = options.now ?? new Date();

  // Replay safety: the sender's clientId is the TRANSFER_OUT row's own
  // clientId (a CODE transfer's WalletTransfer.clientId belongs to the
  // recipient), so that row is the one place a replay is reliably found.
  const replay = await prisma.walletTransaction.findUnique({ where: { clientId } });
  if (replay) {
    const transfer = await prisma.walletTransfer.findFirst({ where: { senderTransactionId: replay.id } });
    if (transfer) {
      const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: senderWalletId }, select: { balanceCents: true } });
      return { ok: true, transfer, senderBalanceCents: wallet.balanceCents, replayed: true };
    }
  }

  await expireTransfers(now);

  if (!Number.isInteger(amountCents) || amountCents < MIN_TRANSFER_CENTS) return fail("AMOUNT_TOO_LOW");
  if (amountCents > MAX_TRANSFER_CENTS) return fail("AMOUNT_TOO_HIGH");
  if (senderWalletId === recipientWalletId) return fail("SELF_TRANSFER");

  const [sender, recipient] = await Promise.all([loadWallet(senderWalletId), loadWallet(recipientWalletId)]);
  if (!sender || !recipient) return fail("WALLET_NOT_FOUND");
  if (sender.ownerUserId === recipient.ownerUserId) return fail("SELF_TRANSFER");
  if (sender.eventId !== recipient.eventId) return fail("DIFFERENT_EVENT");
  const blocked = assertTransferable(sender);
  if (blocked) return fail(blocked);

  if (method === "CODE") {
    if (!options.offerId) return fail("INVALID_CODE");
    const offer = await prisma.walletTransfer.findUnique({ where: { id: options.offerId } });
    if (!offer || offer.recipientWalletId !== recipient.id) return fail("INVALID_CODE");
  }

  const recipientFirstName = firstNameOf(recipient.owner.name);

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        // The WHERE clause is the balance floor — same CAS as
        // handleWithdrawWallet, so two concurrent debits can't both pass.
        const debit = await tx.wallet.updateMany({
          where: { id: sender.id, balanceCents: { gte: amountCents } },
          data: { balanceCents: { decrement: amountCents } },
        });
        if (debit.count === 0) throw new TransferAbort("INSUFFICIENT_BALANCE");

        let transferId: string;
        if (method === "CODE") {
          // Claiming the offer is the single-use guard: it only matches an
          // unclaimed, unexpired offer, so a second sender (or a replay
          // after the first claim) gets count 0 and the debit rolls back.
          const claimed = await tx.walletTransfer.updateMany({
            where: { id: options.offerId, status: "PENDING", senderWalletId: null, expiresAt: { gt: now } },
            data: { senderWalletId: sender.id, amountCents, currency: sender.currency, method },
          });
          if (claimed.count === 0) throw new TransferAbort("CODE_EXPIRED");
          transferId = options.offerId!;
        } else {
          const created = await tx.walletTransfer.create({
            data: {
              clientId,
              method,
              status: "PENDING",
              amountCents,
              currency: sender.currency,
              initiatedAt: now,
              expiresAt: new Date(now.getTime() + TRANSFER_EXPIRY_MS),
              senderWalletId: sender.id,
              recipientWalletId: recipient.id,
              eventId: sender.eventId,
            },
          });
          transferId = created.id;
        }

        const out = await tx.walletTransaction.create({
          data: {
            clientId,
            type: "TRANSFER_OUT",
            status: "PENDING",
            amountCents,
            currency: sender.currency,
            walletId: sender.id,
            note: recipientFirstName,
          },
        });
        const transfer = await tx.walletTransfer.update({
          where: { id: transferId },
          data: { senderTransactionId: out.id },
        });
        const updatedSender = await tx.wallet.findUniqueOrThrow({
          where: { id: sender.id },
          select: { balanceCents: true },
        });
        return { transfer, senderBalanceCents: updatedSender.balanceCents };
      },
      { timeout: 15000, maxWait: 10000 }
    );
    return { ok: true, ...result, replayed: false };
  } catch (error) {
    if (error instanceof TransferAbort) return fail(error.reason);
    throw error;
  }
}

export async function completeTransfer(
  transferId: string,
  now: Date = new Date()
): Promise<
  | { ok: true; transfer: WalletTransfer; senderBalanceCents: number; recipientBalanceCents: number; alreadyCompleted: boolean }
  | Failure
> {
  const transfer = await prisma.walletTransfer.findUnique({ where: { id: transferId } });
  if (!transfer) return fail("TRANSFER_NOT_FOUND");

  const balances = async () => {
    const [s, r] = await Promise.all([
      transfer.senderWalletId
        ? prisma.wallet.findUniqueOrThrow({ where: { id: transfer.senderWalletId }, select: { balanceCents: true } })
        : null,
      prisma.wallet.findUniqueOrThrow({ where: { id: transfer.recipientWalletId }, select: { balanceCents: true } }),
    ]);
    return { senderBalanceCents: s?.balanceCents ?? 0, recipientBalanceCents: r.balanceCents };
  };

  if (transfer.status === "COMPLETED") {
    return { ok: true, transfer, alreadyCompleted: true, ...(await balances()) };
  }
  if (transfer.status === "CANCELLED") return fail("TRANSFER_CANCELLED");
  if (transfer.status === "EXPIRED") return fail("TRANSFER_EXPIRED");
  if (!transfer.senderWalletId || !transfer.senderTransactionId || !transfer.amountCents) return fail("NOT_CLAIMED");
  if (transfer.expiresAt <= now) {
    await reverseTransfer(transfer.id, "EXPIRED");
    return fail("TRANSFER_EXPIRED");
  }

  const senderWalletId = transfer.senderWalletId;
  const senderTransactionId = transfer.senderTransactionId;
  const amountCents = transfer.amountCents;

  const [sender, recipient] = await Promise.all([loadWallet(senderWalletId), loadWallet(transfer.recipientWalletId)]);
  if (!sender || !recipient) return fail("WALLET_NOT_FOUND");

  const completed = await prisma.$transaction(
    async (tx) => {
      // Compare-and-swap on status (and expiry): only one caller moves the
      // transfer out of PENDING, so the recipient is credited exactly once
      // even if complete is replayed or races an expiry.
      const claimed = await tx.walletTransfer.updateMany({
        where: { id: transfer.id, status: "PENDING", expiresAt: { gt: now } },
        data: { status: "COMPLETED", completedAt: now },
      });
      if (claimed.count === 0) return null;

      const credited = await tx.wallet.update({
        where: { id: transfer.recipientWalletId },
        data: { balanceCents: { increment: amountCents } },
        select: { balanceCents: true },
      });
      const incoming = await tx.walletTransaction.create({
        data: {
          clientId: `wallet-transfer-in:${transfer.id}`,
          type: "TRANSFER_IN",
          status: "COMPLETED",
          amountCents,
          currency: transfer.currency,
          walletId: transfer.recipientWalletId,
          note: firstNameOf(sender.owner.name),
        },
      });
      await tx.walletTransaction.updateMany({
        where: { id: senderTransactionId, status: "PENDING" },
        data: { status: "COMPLETED" },
      });
      const done = await tx.walletTransfer.update({
        where: { id: transfer.id },
        data: { recipientTransactionId: incoming.id },
      });
      const debited = await tx.wallet.findUniqueOrThrow({ where: { id: senderWalletId }, select: { balanceCents: true } });
      return { transfer: done, senderBalanceCents: debited.balanceCents, recipientBalanceCents: credited.balanceCents };
    },
    { timeout: 15000, maxWait: 10000 }
  );

  if (!completed) {
    // Lost a race — report what actually happened rather than guessing.
    const now2 = await prisma.walletTransfer.findUniqueOrThrow({ where: { id: transfer.id } });
    if (now2.status === "COMPLETED") return { ok: true, transfer: now2, alreadyCompleted: true, ...(await balances()) };
    return fail(now2.status === "CANCELLED" ? "TRANSFER_CANCELLED" : "TRANSFER_EXPIRED");
  }

  // Best-effort, after commit and only for the call that made the
  // transition — the money has already moved, so a WhatsApp failure must
  // not turn that into an error (same stance as pending-topups.ts).
  const currency = transfer.currency;
  const notices: { phone: string | null; type: "WALLET_TRANSFER_SENT" | "WALLET_TRANSFER_RECEIVED"; subject: string; body: string }[] = [
    {
      phone: sender.owner.phone,
      type: "WALLET_TRANSFER_SENT",
      subject: "Transfer sent",
      body: `You sent ${formatCents(amountCents, currency)} to ${firstNameOf(recipient.owner.name)}. New balance: ${formatCents(completed.senderBalanceCents, currency)}`,
    },
    {
      phone: recipient.owner.phone,
      type: "WALLET_TRANSFER_RECEIVED",
      subject: "Transfer received",
      body: `You received ${formatCents(amountCents, currency)} from ${firstNameOf(sender.owner.name)}. New balance: ${formatCents(completed.recipientBalanceCents, currency)}`,
    },
  ];
  for (const notice of notices) {
    if (!notice.phone) continue;
    try {
      await sendNotification({
        type: notice.type,
        channel: "WHATSAPP",
        recipient: notice.phone,
        subject: notice.subject,
        body: notice.body,
      });
    } catch (error) {
      console.error("[wallet-transfer] notification failed", transfer.id, error);
    }
  }

  return { ok: true, ...completed, alreadyCompleted: false };
}
