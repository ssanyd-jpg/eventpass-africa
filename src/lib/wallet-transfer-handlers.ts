import { prisma } from "@/lib/prisma";
import { shapeWallet, shapeWalletTransaction } from "@/lib/sync-handlers";
import {
  completeTransfer,
  firstNameOf,
  initiateTransfer,
  resolveRecipient,
  type RecipientLookup,
  type TransferFailure,
} from "@/lib/wallet-transfer";

// Session 37 — the outbox side of peer-to-peer wallet transfers. The money
// logic is all in wallet-transfer.ts; this file only does what every
// sync handler does: resolve the caller's wallet by id or offline clientId,
// check they own it, translate the payload, and shape the result for the
// client's apply function (see sync-engine.ts).
//
// A business-rule rejection (expired code, no such number, insufficient
// balance…) comes back as ok:true + declined:true — the same soft-decline
// shape CHARGE_WALLET and WITHDRAW_WALLET use — rather than ok:false. The
// outbox silently drops a non-retryable ok:false, which would leave the
// sender's local "sending…" row stuck forever; a declined result reaches the
// apply function, which marks that row failed with a message. Only "the
// sender's wallet hasn't synced yet" is a real retry.

const walletInclude = {
  event: { select: { id: true, clientId: true, status: true, currency: true, organizationId: true } },
  owner: { select: { name: true, email: true, phone: true } },
  ticketGroup: { select: { name: true } },
} as const;

async function resolveSenderWallet(walletId: string, walletClientId?: string | null) {
  return (
    (await prisma.wallet.findUnique({ where: { id: walletId }, include: walletInclude })) ??
    (walletClientId ? await prisma.wallet.findUnique({ where: { clientId: walletClientId }, include: walletInclude }) : null)
  );
}

function declined(reason: TransferFailure) {
  return { ok: true as const, declined: true as const, reason };
}

function lookupFromPayload(payload: any): RecipientLookup | null {
  switch (payload.method) {
    case "NFC":
      return payload.nfcUid ? { method: "NFC", nfcUid: String(payload.nfcUid) } : null;
    case "CODE":
      return payload.code ? { method: "CODE", code: String(payload.code) } : null;
    case "PHONE":
      return payload.phone ? { method: "PHONE", phone: String(payload.phone) } : null;
    default:
      return null;
  }
}

export async function handleInitiateWalletTransfer(userId: string, payload: any) {
  const clientId = String(payload.clientId);

  const sender = await resolveSenderWallet(String(payload.senderWalletId), payload.senderWalletClientId);
  if (!sender) return { ok: false, retry: true, reason: "WALLET_NOT_SYNCED_YET" };
  if (sender.ownerUserId !== userId) return { ok: false, reason: "FORBIDDEN" };

  // Replay: the first run already did everything; just report it again.
  const replay = await prisma.walletTransaction.findUnique({ where: { clientId }, include: { vendor: true, sponsor: true, campaign: true } });
  if (replay) {
    const existing = await prisma.walletTransfer.findFirst({ where: { senderTransactionId: replay.id } });
    return {
      ok: true,
      transfer: existing ? { id: existing.id, status: existing.status } : null,
      transaction: shapeWalletTransaction(replay),
      wallet: shapeWallet(sender),
    };
  }

  const lookup = lookupFromPayload(payload);
  if (!lookup) return declined("RECIPIENT_NOT_FOUND");

  // Re-resolved here rather than trusting an id from the client, so a code
  // entered offline is checked at sync time — when it may have expired.
  const resolved = await resolveRecipient(sender.id, lookup);
  if (!resolved.ok) return declined(resolved.reason);

  const result = await initiateTransfer(
    sender.id,
    resolved.recipient.walletId,
    Number(payload.amountCents),
    payload.method,
    clientId,
    { offerId: resolved.recipient.offerId }
  );
  if (!result.ok) return declined(result.reason);

  const [transaction, wallet] = await Promise.all([
    prisma.walletTransaction.findUniqueOrThrow({ where: { id: result.transfer.senderTransactionId! }, include: { vendor: true, sponsor: true, campaign: true } }),
    prisma.wallet.findUniqueOrThrow({ where: { id: sender.id }, include: walletInclude }),
  ]);

  return {
    ok: true,
    transfer: { id: result.transfer.id, status: result.transfer.status },
    recipientFirstName: resolved.recipient.firstName,
    transaction: shapeWalletTransaction(transaction),
    wallet: shapeWallet(wallet),
  };
}

export async function handleCompleteWalletTransfer(userId: string, payload: any) {
  const sender = await resolveSenderWallet(String(payload.senderWalletId), payload.senderWalletClientId);
  if (!sender) return { ok: false, retry: true, reason: "WALLET_NOT_SYNCED_YET" };
  if (sender.ownerUserId !== userId) return { ok: false, reason: "FORBIDDEN" };

  // The transfer's server id isn't known to an offline client, but the
  // TRANSFER_OUT row it created carries the INITIATE op's clientId.
  const outgoing = await prisma.walletTransaction.findUnique({ where: { clientId: String(payload.initiateClientId) } });
  const transfer = outgoing ? await prisma.walletTransfer.findFirst({ where: { senderTransactionId: outgoing.id } }) : null;
  // No TRANSFER_OUT row yet means the INITIATE op hasn't committed — the
  // outbox only orders two ops within ONE flush, and a COMPLETE queued while
  // INITIATE is still in flight is picked up by a second, concurrent flush.
  // That is "not synced yet", exactly like an unsynced wallet, so ask for a
  // retry instead of dropping the op (a dropped COMPLETE strands the sender's
  // debit until the transfer expires). If INITIATE was instead declined, the
  // client removes this queued COMPLETE (see abandonTransferCompletion).
  if (!outgoing) return { ok: false, retry: true, reason: "TRANSFER_NOT_SYNCED_YET" };
  // Only the sender's own transfer — never complete someone else's.
  if (!transfer || transfer.senderWalletId !== sender.id) return declined("TRANSFER_NOT_FOUND");

  const result = await completeTransfer(transfer.id);
  if (!result.ok) return declined(result.reason);

  const [transaction, wallet, recipient] = await Promise.all([
    prisma.walletTransaction.findUniqueOrThrow({ where: { id: transfer.senderTransactionId! }, include: { vendor: true, sponsor: true, campaign: true } }),
    prisma.wallet.findUniqueOrThrow({ where: { id: sender.id }, include: walletInclude }),
    prisma.wallet.findUniqueOrThrow({ where: { id: transfer.recipientWalletId }, select: { owner: { select: { name: true } } } }),
  ]);

  return {
    ok: true,
    transfer: { id: result.transfer.id, status: result.transfer.status },
    recipientFirstName: firstNameOf(recipient.owner.name),
    transaction: shapeWalletTransaction(transaction),
    wallet: shapeWallet(wallet),
  };
}
