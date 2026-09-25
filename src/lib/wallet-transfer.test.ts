import { describe, expect, it, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestEvent, createTestOrganization, createTestUser, createTestWallet } from "@/lib/test-fixtures";
import { formatCents } from "@/lib/format";
import { getOrganizerAnalyticsData } from "@/lib/analytics-data";
import { payloadSchemas } from "@/lib/sync-handlers";
import {
  MAX_TRANSFER_CENTS,
  MIN_TRANSFER_CENTS,
  cancelTransfer,
  completeTransfer,
  createReceiveCode,
  expireTransfers,
  firstNameOf,
  initiateTransfer,
  resolveRecipient,
  summarizeTransferVolume,
} from "@/lib/wallet-transfer";
import { handleCompleteWalletTransfer, handleInitiateWalletTransfer } from "@/lib/wallet-transfer-handlers";

// Session 37 — peer-to-peer wallet transfers. Everything runs against the
// real test database (see vitest.global-setup.ts); WhatsApp goes through the
// LOGGED fallback (no AT credentials in test), so notifications are asserted
// via NotificationLog rows, same as pending-topups.test.ts.

let seq = 0;
const MINUTE = 60 * 1000;

// Same Neon connection-pool drain as wallet-handlers.test.ts.
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
});

async function user(name: string) {
  const u = await createTestUser({ name });
  const phone = `+2557${String(Date.now() % 10_000_000).padStart(7, "0")}${++seq % 10}`;
  await prisma.user.update({ where: { id: u.id }, data: { phone } });
  return { ...u, phone };
}

async function setupEvent(opts: { transferEnabled?: boolean; currency?: string } = {}) {
  const organization = await createTestOrganization();
  const event = await createTestEvent(organization.id, undefined, opts.currency ?? "TZS");
  await prisma.event.update({ where: { id: event.id }, data: { transferEnabled: opts.transferEnabled ?? true } });
  return { organization, event };
}

async function attendee(eventId: string, name: string, balanceCents: number) {
  const owner = await user(name);
  const wallet = await createTestWallet(eventId, owner.id, { balanceCents });
  return { owner, wallet };
}

// A sender with TZS 50,000 and a recipient with TZS 10,000 at the same event.
async function pair() {
  const { organization, event } = await setupEvent();
  const sender = await attendee(event.id, "Amina Juma", 5_000_000);
  const recipient = await attendee(event.id, "Baraka Mushi", 1_000_000);
  return { organization, event, sender, recipient };
}

const balanceOf = async (walletId: string) =>
  (await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } })).balanceCents;

let clientSeq = 0;
const cid = () => `wt-${Date.now()}-${++clientSeq}`;

async function sendAndComplete(senderWalletId: string, recipientWalletId: string, amountCents: number) {
  const started = await initiateTransfer(senderWalletId, recipientWalletId, amountCents, "PHONE", cid());
  if (!started.ok) throw new Error(`initiate failed: ${started.reason}`);
  const done = await completeTransfer(started.transfer.id);
  if (!done.ok) throw new Error(`complete failed: ${done.reason}`);
  return done;
}

describe("firstNameOf", () => {
  it("returns only the first word, with a neutral fallback for a nameless account", () => {
    expect(firstNameOf("Amina Juma Hassan")).toBe("Amina");
    expect(firstNameOf("  Baraka  ")).toBe("Baraka");
    expect(firstNameOf("")).toBe("Someone");
    expect(firstNameOf(null)).toBe("Someone");
  });
});

describe("initiateTransfer / completeTransfer — money movement", () => {
  it("debits the sender immediately, as a PENDING TRANSFER_OUT naming the recipient by first name", async () => {
    const { sender, recipient } = await pair();

    const started = await initiateTransfer(sender.wallet.id, recipient.wallet.id, 500_000, "PHONE", cid());

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.senderBalanceCents).toBe(4_500_000);
    expect(await balanceOf(sender.wallet.id)).toBe(4_500_000);
    // Nothing reaches the recipient until the transfer is completed.
    expect(await balanceOf(recipient.wallet.id)).toBe(1_000_000);

    const out = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: started.transfer.senderTransactionId! } });
    expect(out).toMatchObject({ type: "TRANSFER_OUT", status: "PENDING", amountCents: 500_000, walletId: sender.wallet.id, note: "Baraka" });
    expect(started.transfer).toMatchObject({ status: "PENDING", method: "PHONE", amountCents: 500_000 });
    // 15-minute window from initiation.
    expect(started.transfer.expiresAt.getTime() - started.transfer.initiatedAt.getTime()).toBe(15 * MINUTE);
  });

  it("credits the recipient on completion with a TRANSFER_IN naming the sender, and settles both rows", async () => {
    const { sender, recipient } = await pair();

    const done = await sendAndComplete(sender.wallet.id, recipient.wallet.id, 500_000);

    expect(done.alreadyCompleted).toBe(false);
    expect(done.senderBalanceCents).toBe(4_500_000);
    expect(done.recipientBalanceCents).toBe(1_500_000);
    expect(await balanceOf(recipient.wallet.id)).toBe(1_500_000);

    const transfer = await prisma.walletTransfer.findUniqueOrThrow({ where: { id: done.transfer.id } });
    expect(transfer.status).toBe("COMPLETED");
    expect(transfer.completedAt).not.toBeNull();

    const out = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: transfer.senderTransactionId! } });
    const incoming = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: transfer.recipientTransactionId! } });
    expect(out.status).toBe("COMPLETED");
    expect(incoming).toMatchObject({ type: "TRANSFER_IN", status: "COMPLETED", amountCents: 500_000, walletId: recipient.wallet.id, note: "Amina" });
  });

  it("sends each party the WhatsApp message with the other's first name and their own new balance", async () => {
    const { sender, recipient } = await pair();

    await sendAndComplete(sender.wallet.id, recipient.wallet.id, 500_000);

    const sentLog = await prisma.notificationLog.findFirst({ where: { recipient: sender.owner.phone, type: "WALLET_TRANSFER_SENT" } });
    const receivedLog = await prisma.notificationLog.findFirst({ where: { recipient: recipient.owner.phone, type: "WALLET_TRANSFER_RECEIVED" } });
    expect(sentLog?.channel).toBe("WHATSAPP");
    expect(sentLog?.body).toBe(`You sent ${formatCents(500_000, "TZS")} to Baraka. New balance: ${formatCents(4_500_000, "TZS")}`);
    expect(receivedLog?.channel).toBe("WHATSAPP");
    expect(receivedLog?.body).toBe(`You received ${formatCents(500_000, "TZS")} from Amina. New balance: ${formatCents(1_500_000, "TZS")}`);
  });

  it("rejects a transfer bigger than the sender's balance and leaves both balances untouched", async () => {
    const { organization, event } = await setupEvent();
    const sender = await attendee(event.id, "Amina Juma", 200_000);
    const recipient = await attendee(event.id, "Baraka Mushi", 0);
    void organization;

    const result = await initiateTransfer(sender.wallet.id, recipient.wallet.id, 300_000, "PHONE", cid());

    expect(result).toEqual({ ok: false, reason: "INSUFFICIENT_BALANCE" });
    expect(await balanceOf(sender.wallet.id)).toBe(200_000);
    expect(await prisma.walletTransfer.count({ where: { senderWalletId: sender.wallet.id } })).toBe(0);
    expect(await prisma.walletTransaction.count({ where: { walletId: sender.wallet.id, type: "TRANSFER_OUT" } })).toBe(0);
  });

  it("rejects a transfer to yourself, whether by wallet id or by owning both wallets", async () => {
    const { sender } = await pair();

    expect(await initiateTransfer(sender.wallet.id, sender.wallet.id, 200_000, "PHONE", cid())).toEqual({ ok: false, reason: "SELF_TRANSFER" });
    expect(await balanceOf(sender.wallet.id)).toBe(5_000_000);

    // Resolution catches it too: the sender's own phone finds their own wallet.
    const resolved = await resolveRecipient(sender.wallet.id, { method: "PHONE", phone: sender.owner.phone });
    expect(resolved).toEqual({ ok: false, reason: "SELF_TRANSFER" });
  });

  it("enforces the TZS 1,000 minimum and TZS 100,000 maximum", async () => {
    const { event } = await setupEvent();
    const sender = await attendee(event.id, "Amina Juma", 50_000_000);
    const recipient = await attendee(event.id, "Baraka Mushi", 0);

    expect(await initiateTransfer(sender.wallet.id, recipient.wallet.id, MIN_TRANSFER_CENTS - 1, "PHONE", cid())).toEqual({ ok: false, reason: "AMOUNT_TOO_LOW" });
    expect(await initiateTransfer(sender.wallet.id, recipient.wallet.id, MAX_TRANSFER_CENTS + 1, "PHONE", cid())).toEqual({ ok: false, reason: "AMOUNT_TOO_HIGH" });
    // Both bounds are inclusive.
    expect((await initiateTransfer(sender.wallet.id, recipient.wallet.id, MIN_TRANSFER_CENTS, "PHONE", cid())).ok).toBe(true);
    expect((await initiateTransfer(sender.wallet.id, recipient.wallet.id, MAX_TRANSFER_CENTS, "PHONE", cid())).ok).toBe(true);
    expect(MIN_TRANSFER_CENTS).toBe(100_000);
    expect(MAX_TRANSFER_CENTS).toBe(10_000_000);
  });

  it("only allows a transfer between wallets at the same event", async () => {
    const { event } = await setupEvent();
    const other = await setupEvent();
    const sender = await attendee(event.id, "Amina Juma", 5_000_000);
    const stranger = await attendee(other.event.id, "Caro Lema", 0);

    const result = await initiateTransfer(sender.wallet.id, stranger.wallet.id, 200_000, "PHONE", cid());

    expect(result).toEqual({ ok: false, reason: "DIFFERENT_EVENT" });
    expect(await balanceOf(sender.wallet.id)).toBe(5_000_000);
    expect(await balanceOf(stranger.wallet.id)).toBe(0);
  });

  it("is refused when the organiser hasn't enabled transfers for the event", async () => {
    const { event } = await setupEvent({ transferEnabled: false });
    const sender = await attendee(event.id, "Amina Juma", 5_000_000);
    const recipient = await attendee(event.id, "Baraka Mushi", 0);

    expect(await initiateTransfer(sender.wallet.id, recipient.wallet.id, 200_000, "PHONE", cid())).toEqual({ ok: false, reason: "TRANSFERS_DISABLED" });
    expect(await resolveRecipient(sender.wallet.id, { method: "PHONE", phone: recipient.owner.phone })).toEqual({ ok: false, reason: "TRANSFERS_DISABLED" });
    expect(await createReceiveCode(recipient.wallet.id, cid())).toEqual({ ok: false, reason: "TRANSFERS_DISABLED" });
  });

  it("is idempotent: replaying initiate with the same clientId debits once, and replaying complete credits once", async () => {
    const { sender, recipient } = await pair();
    const clientId = cid();

    const first = await initiateTransfer(sender.wallet.id, recipient.wallet.id, 500_000, "PHONE", clientId);
    const replay = await initiateTransfer(sender.wallet.id, recipient.wallet.id, 500_000, "PHONE", clientId);
    expect(first.ok && replay.ok).toBe(true);
    if (!first.ok || !replay.ok) return;
    expect(replay.replayed).toBe(true);
    expect(replay.transfer.id).toBe(first.transfer.id);
    expect(await balanceOf(sender.wallet.id)).toBe(4_500_000);

    await completeTransfer(first.transfer.id);
    const again = await completeTransfer(first.transfer.id);
    expect(again.ok && again.alreadyCompleted).toBe(true);
    expect(await balanceOf(recipient.wallet.id)).toBe(1_500_000);
    expect(await prisma.walletTransaction.count({ where: { walletId: recipient.wallet.id, type: "TRANSFER_IN" } })).toBe(1);
    // ...and only one pair of WhatsApp messages went out.
    expect(await prisma.notificationLog.count({ where: { recipient: recipient.owner.phone, type: "WALLET_TRANSFER_RECEIVED" } })).toBe(1);
  });
});

describe("cancelTransfer / expireTransfers", () => {
  it("cancel reverses the debit: sender refunded, TRANSFER_OUT marked FAILED, recipient never credited", async () => {
    const { sender, recipient } = await pair();
    const started = await initiateTransfer(sender.wallet.id, recipient.wallet.id, 500_000, "PHONE", cid());
    if (!started.ok) throw new Error("setup");
    expect(await balanceOf(sender.wallet.id)).toBe(4_500_000);

    const cancelled = await cancelTransfer(started.transfer.id);

    expect(cancelled.ok).toBe(true);
    expect(await balanceOf(sender.wallet.id)).toBe(5_000_000);
    expect(await balanceOf(recipient.wallet.id)).toBe(1_000_000);
    const transfer = await prisma.walletTransfer.findUniqueOrThrow({ where: { id: started.transfer.id } });
    expect(transfer.status).toBe("CANCELLED");
    const out = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: transfer.senderTransactionId! } });
    expect(out.status).toBe("FAILED");
    expect(out.providerMessage).toBe("Transfer cancelled");
    expect(await prisma.walletTransaction.count({ where: { walletId: recipient.wallet.id, type: "TRANSFER_IN" } })).toBe(0);
  });

  it("cancelling twice, or cancelling a completed transfer, refunds nothing extra", async () => {
    const { sender, recipient } = await pair();
    const started = await initiateTransfer(sender.wallet.id, recipient.wallet.id, 500_000, "PHONE", cid());
    if (!started.ok) throw new Error("setup");

    await cancelTransfer(started.transfer.id);
    expect(await cancelTransfer(started.transfer.id)).toEqual({ ok: false, reason: "NOT_PENDING" });
    expect(await balanceOf(sender.wallet.id)).toBe(5_000_000);

    const done = await sendAndComplete(sender.wallet.id, recipient.wallet.id, 300_000);
    expect(await cancelTransfer(done.transfer.id)).toEqual({ ok: false, reason: "NOT_PENDING" });
    expect(await balanceOf(sender.wallet.id)).toBe(4_700_000);
  });

  it("expireTransfers refunds a transfer left PENDING for 15 minutes and marks it EXPIRED", async () => {
    const { sender, recipient } = await pair();
    const t0 = new Date();
    const started = await initiateTransfer(sender.wallet.id, recipient.wallet.id, 500_000, "PHONE", cid(), { now: t0 });
    if (!started.ok) throw new Error("setup");

    // Just inside the window: untouched.
    await expireTransfers(new Date(t0.getTime() + 14 * MINUTE));
    expect((await prisma.walletTransfer.findUniqueOrThrow({ where: { id: started.transfer.id } })).status).toBe("PENDING");
    expect(await balanceOf(sender.wallet.id)).toBe(4_500_000);

    await expireTransfers(new Date(t0.getTime() + 16 * MINUTE));

    const transfer = await prisma.walletTransfer.findUniqueOrThrow({ where: { id: started.transfer.id } });
    expect(transfer.status).toBe("EXPIRED");
    expect(await balanceOf(sender.wallet.id)).toBe(5_000_000);
    const out = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: transfer.senderTransactionId! } });
    expect(out).toMatchObject({ status: "FAILED", providerMessage: "Transfer expired" });
  });

  it("completing a transfer after its 15 minutes fails and refunds the sender instead of crediting the recipient", async () => {
    const { sender, recipient } = await pair();
    const t0 = new Date();
    const started = await initiateTransfer(sender.wallet.id, recipient.wallet.id, 500_000, "PHONE", cid(), { now: t0 });
    if (!started.ok) throw new Error("setup");

    const late = await completeTransfer(started.transfer.id, new Date(t0.getTime() + 16 * MINUTE));

    expect(late).toEqual({ ok: false, reason: "TRANSFER_EXPIRED" });
    expect(await balanceOf(sender.wallet.id)).toBe(5_000_000);
    expect(await balanceOf(recipient.wallet.id)).toBe(1_000_000);
    expect((await prisma.walletTransfer.findUniqueOrThrow({ where: { id: started.transfer.id } })).status).toBe("EXPIRED");
  });

  it("every new transfer initiation sweeps stale transfers first — no cron needed", async () => {
    const { event } = await setupEvent();
    const a = await attendee(event.id, "Amina Juma", 5_000_000);
    const b = await attendee(event.id, "Baraka Mushi", 0);
    const c = await attendee(event.id, "Caro Lema", 5_000_000);
    const t0 = new Date();
    const stale = await initiateTransfer(a.wallet.id, b.wallet.id, 500_000, "PHONE", cid(), { now: t0 });
    if (!stale.ok) throw new Error("setup");
    expect(await balanceOf(a.wallet.id)).toBe(4_500_000);

    // An unrelated pair starts a transfer 20 minutes later.
    await initiateTransfer(c.wallet.id, b.wallet.id, 200_000, "PHONE", cid(), { now: new Date(t0.getTime() + 20 * MINUTE) });

    expect((await prisma.walletTransfer.findUniqueOrThrow({ where: { id: stale.transfer.id } })).status).toBe("EXPIRED");
    expect(await balanceOf(a.wallet.id)).toBe(5_000_000);
  });
});

describe("Method B — transfer code", () => {
  it("creates a 6-digit code valid for 15 minutes that resolves to the recipient by first name", async () => {
    const { sender, recipient } = await pair();
    const t0 = new Date();

    const receive = await createReceiveCode(recipient.wallet.id, cid(), t0);

    expect(receive.ok).toBe(true);
    if (!receive.ok) return;
    expect(receive.code).toMatch(/^\d{6}$/);
    expect(receive.expiresAt.getTime()).toBe(t0.getTime() + 15 * MINUTE);

    const resolved = await resolveRecipient(sender.wallet.id, { method: "CODE", code: receive.code }, new Date(t0.getTime() + 5 * MINUTE));
    expect(resolved).toMatchObject({ ok: true, recipient: { walletId: recipient.wallet.id, firstName: "Baraka", offerId: receive.transferId } });
  });

  it("is idempotent on clientId and retires the wallet's previous code when a new one is requested", async () => {
    const { sender, recipient } = await pair();
    const clientId = cid();

    const first = await createReceiveCode(recipient.wallet.id, clientId);
    const replay = await createReceiveCode(recipient.wallet.id, clientId);
    if (!first.ok || !replay.ok) throw new Error("setup");
    expect(replay.code).toBe(first.code);

    const second = await createReceiveCode(recipient.wallet.id, cid());
    if (!second.ok) throw new Error("setup");
    const oldCode = await resolveRecipient(sender.wallet.id, { method: "CODE", code: first.code });
    // The old code is retired, so it's no longer valid (unless the new one
    // happened to draw the same digits, in which case it correctly resolves).
    if (second.code !== first.code) expect(oldCode.ok).toBe(false);
    expect((await resolveRecipient(sender.wallet.id, { method: "CODE", code: second.code })).ok).toBe(true);
  });

  it("rejects an expired code after 15 minutes", async () => {
    const { sender, recipient } = await pair();
    const t0 = new Date();
    const receive = await createReceiveCode(recipient.wallet.id, cid(), t0);
    if (!receive.ok) throw new Error("setup");

    const late = await resolveRecipient(sender.wallet.id, { method: "CODE", code: receive.code }, new Date(t0.getTime() + 16 * MINUTE));

    expect(late).toEqual({ ok: false, reason: "CODE_EXPIRED" });
    expect((await prisma.walletTransfer.findUniqueOrThrow({ where: { id: receive.transferId } })).status).toBe("EXPIRED");
  });

  it("rejects a code that was never issued, and a malformed one", async () => {
    const { sender } = await pair();

    expect(await resolveRecipient(sender.wallet.id, { method: "CODE", code: "12" })).toEqual({ ok: false, reason: "INVALID_CODE" });
    expect(await resolveRecipient(sender.wallet.id, { method: "CODE", code: "abcdef" })).toEqual({ ok: false, reason: "INVALID_CODE" });
  });

  it("can't be used to reach a wallet at another event", async () => {
    const { event } = await setupEvent();
    const other = await setupEvent();
    const sender = await attendee(event.id, "Amina Juma", 5_000_000);
    const stranger = await attendee(other.event.id, "Caro Lema", 0);
    const receive = await createReceiveCode(stranger.wallet.id, cid());
    if (!receive.ok) throw new Error("setup");

    expect((await resolveRecipient(sender.wallet.id, { method: "CODE", code: receive.code })).ok).toBe(false);
  });

  it("is single-use: the sender claims it, debits once, and a second sender is refused", async () => {
    const { event } = await setupEvent();
    const first = await attendee(event.id, "Amina Juma", 5_000_000);
    const second = await attendee(event.id, "Caro Lema", 5_000_000);
    const recipient = await attendee(event.id, "Baraka Mushi", 0);
    const receive = await createReceiveCode(recipient.wallet.id, cid());
    if (!receive.ok) throw new Error("setup");

    const claimed = await initiateTransfer(first.wallet.id, recipient.wallet.id, 400_000, "CODE", cid(), { offerId: receive.transferId });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(claimed.transfer).toMatchObject({ id: receive.transferId, senderWalletId: first.wallet.id, amountCents: 400_000, method: "CODE" });

    const late = await initiateTransfer(second.wallet.id, recipient.wallet.id, 400_000, "CODE", cid(), { offerId: receive.transferId });
    expect(late.ok).toBe(false);
    // The rolled-back claim must not have kept the second sender's debit.
    expect(await balanceOf(second.wallet.id)).toBe(5_000_000);

    const done = await completeTransfer(receive.transferId);
    expect(done.ok).toBe(true);
    expect(await balanceOf(recipient.wallet.id)).toBe(400_000);
    expect(await balanceOf(first.wallet.id)).toBe(4_600_000);
  });

  it("can't complete a code offer nobody has claimed yet", async () => {
    const { recipient } = await pair();
    const receive = await createReceiveCode(recipient.wallet.id, cid());
    if (!receive.ok) throw new Error("setup");

    expect(await completeTransfer(receive.transferId)).toEqual({ ok: false, reason: "NOT_CLAIMED" });
    expect(await balanceOf(recipient.wallet.id)).toBe(1_000_000);
  });
});

describe("recipient lookup — phone and NFC", () => {
  it("finds the wallet for a phone number at this event only, however the number is written", async () => {
    const { event, sender, recipient } = await pair();
    // Someone else with a wallet at a DIFFERENT event and their own number.
    const other = await setupEvent();
    const elsewhere = await attendee(other.event.id, "Caro Lema", 0);
    // A wallet holder at the SAME event, so a wrong lookup would be visible.
    await attendee(event.id, "Dina Kileo", 0);

    const local = "0" + recipient.owner.phone.slice(4); // +255754… → 0754…
    for (const written of [recipient.owner.phone, local]) {
      const found = await resolveRecipient(sender.wallet.id, { method: "PHONE", phone: written });
      expect(found).toMatchObject({ ok: true, recipient: { walletId: recipient.wallet.id, firstName: "Baraka" } });
    }
    // A number that only has a wallet at another event looks like no wallet at all.
    expect(await resolveRecipient(sender.wallet.id, { method: "PHONE", phone: elsewhere.owner.phone })).toEqual({ ok: false, reason: "RECIPIENT_NOT_FOUND" });
    expect(await resolveRecipient(sender.wallet.id, { method: "PHONE", phone: "+255700000000" })).toEqual({ ok: false, reason: "RECIPIENT_NOT_FOUND" });
  });

  it("resolves an NFC wristband UID to the wallet it's provisioned to, via the Credential table", async () => {
    const { organization, event, sender, recipient } = await pair();
    const bystander = await attendee(event.id, "Dina Kileo", 0);
    const uid = `04:a2:1f:${Date.now().toString(16)}`;
    const base = { organizationId: organization.id, createdByUserId: sender.owner.id, createdByName: "Staff" };
    await prisma.credential.create({ data: { ...base, code: recipient.wallet.code, nfcUid: uid, walletId: recipient.wallet.id } });
    await prisma.credential.create({ data: { ...base, code: bystander.wallet.code, nfcUid: `${uid}:x`, walletId: bystander.wallet.id } });

    const found = await resolveRecipient(sender.wallet.id, { method: "NFC", nfcUid: uid });

    expect(found).toMatchObject({ ok: true, recipient: { walletId: recipient.wallet.id, firstName: "Baraka" } });
    expect(await resolveRecipient(sender.wallet.id, { method: "NFC", nfcUid: "04:ff:ff:ff" })).toEqual({ ok: false, reason: "RECIPIENT_NOT_FOUND" });
  });

  it("ignores a superseded (replaced) wristband, and refuses a wristband from a different event", async () => {
    const { organization, event, sender, recipient } = await pair();
    const other = await setupEvent();
    const stranger = await attendee(other.event.id, "Caro Lema", 0);
    const base = { organizationId: organization.id, createdByUserId: sender.owner.id, createdByName: "Staff" };
    const oldUid = `04:01:${Date.now().toString(16)}`;
    const foreignUid = `04:02:${Date.now().toString(16)}`;
    await prisma.credential.create({ data: { ...base, code: recipient.wallet.code, nfcUid: oldUid, walletId: recipient.wallet.id, status: "SUPERSEDED", supersededAt: new Date() } });
    await prisma.credential.create({ data: { ...base, code: stranger.wallet.code, nfcUid: foreignUid, walletId: stranger.wallet.id } });

    expect(await resolveRecipient(sender.wallet.id, { method: "NFC", nfcUid: oldUid })).toEqual({ ok: false, reason: "RECIPIENT_NOT_FOUND" });
    expect(await resolveRecipient(sender.wallet.id, { method: "NFC", nfcUid: foreignUid })).toEqual({ ok: false, reason: "DIFFERENT_EVENT" });
    void event;
  });

  it("refuses a tap on your own wristband", async () => {
    const { organization, sender } = await pair();
    const uid = `04:03:${Date.now().toString(16)}`;
    await prisma.credential.create({
      data: { organizationId: organization.id, createdByUserId: sender.owner.id, createdByName: "Staff", code: sender.wallet.code, nfcUid: uid, walletId: sender.wallet.id },
    });

    expect(await resolveRecipient(sender.wallet.id, { method: "NFC", nfcUid: uid })).toEqual({ ok: false, reason: "SELF_TRANSFER" });
  });
});

describe("outbox handlers — INITIATE_WALLET_TRANSFER / COMPLETE_WALLET_TRANSFER", () => {
  it("moves the money end-to-end from an offline-style payload, resolving the code at sync time", async () => {
    const { sender, recipient } = await pair();
    const receive = await createReceiveCode(recipient.wallet.id, cid());
    if (!receive.ok) throw new Error("setup");
    const initiateClientId = cid();

    const started = await handleInitiateWalletTransfer(sender.owner.id, {
      clientId: initiateClientId,
      senderWalletId: sender.wallet.id,
      method: "CODE",
      amountCents: 600_000,
      code: receive.code,
    });
    expect(started).toMatchObject({ ok: true, recipientFirstName: "Baraka", transaction: { type: "TRANSFER_OUT", status: "PENDING", clientId: initiateClientId }, wallet: { balanceCents: 4_400_000 } });

    const completed = await handleCompleteWalletTransfer(sender.owner.id, {
      clientId: cid(),
      senderWalletId: sender.wallet.id,
      initiateClientId,
    });
    expect(completed).toMatchObject({ ok: true, transaction: { status: "COMPLETED" }, wallet: { balanceCents: 4_400_000 } });
    expect(await balanceOf(recipient.wallet.id)).toBe(1_600_000);
  });

  it("is safe to replay both ops after a dropped response", async () => {
    const { sender, recipient } = await pair();
    const initiateClientId = cid();
    const initiate = { clientId: initiateClientId, senderWalletId: sender.wallet.id, method: "PHONE", amountCents: 500_000, phone: recipient.owner.phone };
    const complete = { clientId: cid(), senderWalletId: sender.wallet.id, initiateClientId };

    await handleInitiateWalletTransfer(sender.owner.id, initiate);
    await handleInitiateWalletTransfer(sender.owner.id, initiate);
    await handleCompleteWalletTransfer(sender.owner.id, complete);
    await handleCompleteWalletTransfer(sender.owner.id, complete);

    expect(await balanceOf(sender.wallet.id)).toBe(4_500_000);
    expect(await balanceOf(recipient.wallet.id)).toBe(1_500_000);
  }, 240_000);

  it("returns an expired offline code as a soft decline (so the outbox can show it) and moves no money", async () => {
    const { sender, recipient } = await pair();
    const t0 = new Date(Date.now() - 20 * MINUTE);
    const receive = await createReceiveCode(recipient.wallet.id, cid(), t0);
    if (!receive.ok) throw new Error("setup");

    const result = await handleInitiateWalletTransfer(sender.owner.id, {
      clientId: cid(),
      senderWalletId: sender.wallet.id,
      method: "CODE",
      amountCents: 500_000,
      code: receive.code,
    });

    expect(result).toEqual({ ok: true, declined: true, reason: "CODE_EXPIRED" });
    expect(await balanceOf(sender.wallet.id)).toBe(5_000_000);
  });

  it("asks the outbox to retry a COMPLETE that arrives before its INITIATE has committed, then completes once it has", async () => {
    // Regression: the outbox only orders two ops within ONE flush, so a
    // COMPLETE queued while INITIATE is in flight is sent by a second,
    // concurrent flush and can reach the server first. It used to be dropped
    // as TRANSFER_NOT_FOUND, stranding the sender's debit until expiry.
    const { sender, recipient } = await pair();
    const initiateClientId = cid();
    const complete = { clientId: cid(), senderWalletId: sender.wallet.id, initiateClientId };

    const early = await handleCompleteWalletTransfer(sender.owner.id, complete);
    expect(early).toEqual({ ok: false, retry: true, reason: "TRANSFER_NOT_SYNCED_YET" });
    expect(await balanceOf(recipient.wallet.id)).toBe(1_000_000);

    await handleInitiateWalletTransfer(sender.owner.id, {
      clientId: initiateClientId,
      senderWalletId: sender.wallet.id,
      method: "PHONE",
      amountCents: 500_000,
      phone: recipient.owner.phone,
    });
    const retried = await handleCompleteWalletTransfer(sender.owner.id, complete);

    expect(retried).toMatchObject({ ok: true, transaction: { status: "COMPLETED" } });
    expect(await balanceOf(sender.wallet.id)).toBe(4_500_000);
    expect(await balanceOf(recipient.wallet.id)).toBe(1_500_000);
  }, 240_000);

  it("only lets a wallet's owner send from it, and asks the outbox to retry a wallet that hasn't synced yet", async () => {
    const { sender, recipient } = await pair();
    const base = { clientId: cid(), method: "PHONE", amountCents: 500_000, phone: recipient.owner.phone };

    expect(await handleInitiateWalletTransfer(recipient.owner.id, { ...base, senderWalletId: sender.wallet.id })).toEqual({ ok: false, reason: "FORBIDDEN" });
    expect(await handleInitiateWalletTransfer(sender.owner.id, { ...base, senderWalletId: "local:not-synced" })).toEqual({ ok: false, retry: true, reason: "WALLET_NOT_SYNCED_YET" });
    expect(await balanceOf(sender.wallet.id)).toBe(5_000_000);

    // A different user can't complete someone else's transfer either.
    const started = await handleInitiateWalletTransfer(sender.owner.id, { ...base, senderWalletId: sender.wallet.id });
    expect(started).toMatchObject({ ok: true });
    const hijack = await handleCompleteWalletTransfer(recipient.owner.id, { clientId: cid(), senderWalletId: recipient.wallet.id, initiateClientId: base.clientId });
    expect(hijack).toEqual({ ok: true, declined: true, reason: "TRANSFER_NOT_FOUND" });
    expect(await balanceOf(recipient.wallet.id)).toBe(1_000_000);
  });

  it("validates the payload: the recipient identifier must match the method", () => {
    const schema = payloadSchemas.INITIATE_WALLET_TRANSFER;
    const ok = { clientId: "c", senderWalletId: "w", method: "PHONE", amountCents: 100_000, phone: "+255712345678" };
    expect(schema.safeParse(ok).success).toBe(true);
    expect(schema.safeParse({ ...ok, phone: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...ok, method: "NFC" }).success).toBe(false);
    expect(schema.safeParse({ ...ok, method: "NFC", nfcUid: "04:a2", phone: undefined }).success).toBe(true);
    expect(schema.safeParse({ ...ok, method: "TELEPATHY" }).success).toBe(false);
  });
});

describe("organiser analytics — transfer volume", () => {
  it("counts each COMPLETED transfer once (the OUT side), by currency, and ignores pending, cancelled and other types", () => {
    const stats = summarizeTransferVolume([
      { type: "TRANSFER_OUT", status: "COMPLETED", amountCents: 500_000, currency: "TZS" },
      { type: "TRANSFER_IN", status: "COMPLETED", amountCents: 500_000, currency: "TZS" },
      { type: "TRANSFER_OUT", status: "COMPLETED", amountCents: 250_000, currency: "TZS" },
      { type: "TRANSFER_IN", status: "COMPLETED", amountCents: 250_000, currency: "TZS" },
      { type: "TRANSFER_OUT", status: "PENDING", amountCents: 900_000, currency: "TZS" },
      { type: "TRANSFER_OUT", status: "FAILED", amountCents: 800_000, currency: "TZS" },
      { type: "TOPUP", status: "COMPLETED", amountCents: 7_000_000, currency: "TZS" },
      { type: "SALE", status: "COMPLETED", amountCents: 100_000, currency: "TZS" },
    ]);
    expect(stats).toEqual({ transferVolumeByCurrency: { TZS: 750_000 }, transferCount: 2 });
    expect(summarizeTransferVolume([])).toEqual({ transferVolumeByCurrency: {}, transferCount: 0 });
  });

  it("matches what the organiser's analytics query actually sees after real transfers, cancellations and expiries", async () => {
    const { organization, event } = await setupEvent();
    const a = await attendee(event.id, "Amina Juma", 5_000_000);
    const b = await attendee(event.id, "Baraka Mushi", 0);

    await sendAndComplete(a.wallet.id, b.wallet.id, 500_000);
    await sendAndComplete(b.wallet.id, a.wallet.id, 200_000);
    const cancelled = await initiateTransfer(a.wallet.id, b.wallet.id, 900_000, "PHONE", cid());
    if (!cancelled.ok) throw new Error("setup");
    await cancelTransfer(cancelled.transfer.id);
    await initiateTransfer(a.wallet.id, b.wallet.id, 300_000, "PHONE", cid()); // left PENDING

    const { walletTxs } = await getOrganizerAnalyticsData(organization.id);
    const stats = summarizeTransferVolume(walletTxs);

    expect(stats.transferCount).toBe(2);
    expect(stats.transferVolumeByCurrency).toEqual({ TZS: 700_000 });
    // Five sequential transfers plus the analytics query — several dozen Neon
    // round-trips, so it gets more than the 60s default.
  }, 240_000);
});
