import { createHash, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";
import { normalizeTanzaniaPhone } from "@/lib/sms";
import { handleTopupWallet } from "@/lib/sync-handlers";

// Session 31 — USSD for feature-phone attendees, via Africa's Talking's USSD
// product. Unlike SMS/WhatsApp (sendSMS/sendWhatsApp) this is inbound only:
// Africa's Talking POSTs each keypress to /api/ussd and shows whatever
// CON/END string we answer with, so there is no SDK call here and nothing to
// add to src/types/africastalking.d.ts.

export interface UssdCallback {
  sessionId: string;
  serviceCode: string;
  phoneNumber: string;
  // Every input so far in this session, joined by "*" — "" on the first
  // dial, "2" after choosing option 2, "2*25000" after typing an amount.
  text: string;
}

export const MIN_TOPUP_TZS = 2_000;
export const MAX_TOPUP_TZS = 500_000;

// Wallet money is stored as cents (amountCents / balanceCents — see
// formatCents in src/lib/format.ts, which divides by 100 even for
// zero-decimal TZS), so a whole-shilling amount typed at the keypad is
// multiplied up before it goes near a wallet.
const CENTS_PER_TZS = 100;

// USSD screens are ASCII-only on the cheapest handsets, so this deliberately
// isn't formatCents (Intl's currency style inserts a non-breaking space).
function formatTzs(cents: number): string {
  return `TZS ${Math.round(cents / CENTS_PER_TZS).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

// Attendees read this on a phone in Tanzania, so pin the timezone instead of
// inheriting the server's (Vercel runs in UTC — a 23:30 EAT top-up would
// otherwise show tomorrow's date).
function formatUssdDate(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Africa/Dar_es_Salaam",
  });
}

const TRANSACTION_LABELS: Record<string, string> = {
  TOPUP: "Top-up",
  SALE: "Purchase",
  SPONSOR_TAP: "Sponsor tap",
  WITHDRAWAL: "Withdrawal",
  CARRY_OVER: "Carry-over",
  TRANSFER_OUT: "Transfer sent",
  TRANSFER_IN: "Transfer received",
};

const MAIN_MENU = "CON Welcome to Chaap\n1. Check balance\n2. Top up wallet\n3. View last transaction";

/**
 * Whether a request really came from Africa's Talking — compares the shared
 * secret header against AT_USSD_SECRET. Fails closed when the env var isn't
 * set, same as the cron routes' CRON_SECRET check. Both sides are hashed
 * first so timingSafeEqual always compares equal-length buffers (it throws
 * on a length mismatch, which would itself leak the secret's length).
 */
export function verifyUssdSecret(provided: string | null): boolean {
  const secret = process.env.AT_USSD_SECRET;
  if (!secret || !provided) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(provided), digest(secret));
}

// Wallets belonging to whoever owns this phone number. User.phone is stored
// in normalized E.164 (see handleSellTickets), and Africa's Talking sends
// "+255...", so an exact match on the normalized form is enough. One user
// has one wallet per event, so this can return several — a wallet on a LIVE
// event comes first (it's the only kind that can be topped up or spent),
// then most recently touched. TZS only: the top-up limits below are in
// shillings, so a wallet in another currency must never be credited by them.
async function findWalletsForPhone(phoneNumber: string) {
  const phone = normalizeTanzaniaPhone(phoneNumber);
  const wallets = await prisma.wallet.findMany({
    where: { currency: "TZS", owner: { phone } },
    include: { event: { select: { status: true } } },
    orderBy: { updatedAt: "desc" },
  });
  return wallets.sort((a, b) => Number(b.event.status === "LIVE") - Number(a.event.status === "LIVE"));
}

async function checkBalance(phoneNumber: string): Promise<string> {
  const [wallet] = await findWalletsForPhone(phoneNumber);
  if (!wallet) return "END No Chaap wallet found for this number";
  return `END Your Chaap balance is ${formatTzs(wallet.balanceCents)}`;
}

async function lastTransaction(phoneNumber: string): Promise<string> {
  const wallets = await findWalletsForPhone(phoneNumber);
  if (wallets.length === 0) return "END No transactions found";

  const tx = await prisma.walletTransaction.findFirst({
    where: { walletId: { in: wallets.map((w) => w.id) } },
    orderBy: { createdAt: "desc" },
  });
  if (!tx) return "END No transactions found";

  const label = TRANSACTION_LABELS[tx.type] ?? tx.type;
  // SPONSOR_TAP is the one type with no amount.
  const amount = tx.amountCents === null ? "" : ` ${formatTzs(Math.abs(tx.amountCents))}`;
  // A top-up that's still waiting on the M-Pesa prompt, or was declined, is
  // not money in the wallet — say so rather than reporting it as done.
  const state = tx.status === "COMPLETED" ? "" : ` (${tx.status.toLowerCase()})`;
  return `END Last transaction: ${label}${amount}${state} on ${formatUssdDate(tx.createdAt)}`;
}

function parseTopupAmount(raw: string): number | null {
  const trimmed = raw.trim();
  // Digits only — no sign, decimal point, or thousands separator; the length
  // cap keeps Number() well inside safe-integer range before the range check.
  if (!/^\d{1,9}$/.test(trimmed)) return null;
  const amount = Number(trimmed);
  return amount >= MIN_TOPUP_TZS && amount <= MAX_TOPUP_TZS ? amount : null;
}

async function topUp(input: UssdCallback, amountTzs: number): Promise<string> {
  const [wallet] = await findWalletsForPhone(input.phoneNumber);
  if (!wallet) return "END No Chaap wallet found for this number";

  const amountCents = amountTzs * CENTS_PER_TZS;

  // Goes through the same handler the in-app top-up uses, so the charge goes
  // via getActivePaymentProvider() (src/lib/payments/index.ts), and crediting
  // keeps the same $transaction / compare-and-swap discipline. The clientId
  // is derived from the USSD session: WalletTransaction.clientId is unique
  // and the handler short-circuits on it, so if Africa's Talking ever
  // delivers the same final input twice, the second delivery finds the first
  // row instead of raising a second M-Pesa prompt. The network is left unset
  // — USSD doesn't tell us which one the caller is on, and an unset network
  // defaults to M-Pesa (see ChargeRequest.mobileNetwork).
  const result = await handleTopupWallet(wallet.ownerUserId, {
    clientId: `ussd:${input.sessionId}`,
    walletId: wallet.id,
    amountCents,
    phoneNumber: normalizeTanzaniaPhone(input.phoneNumber),
  });

  if (!result.ok) {
    if (result.reason === "EVENT_NOT_LIVE") return "END Top-ups are not available for your event right now";
    return "END We could not start your top-up. Please try again later";
  }

  const status = result.transaction?.status;
  if (status === "COMPLETED") {
    // Only happens on the simulated provider (real Airpay always answers
    // PENDING first) — the balance really has changed, so say that instead
    // of promising a prompt that will never come.
    const balance = result.wallet ? ` New balance: ${formatTzs(result.wallet.balanceCents)}` : "";
    return `END Your top-up of ${formatTzs(amountCents)} is complete.${balance}`;
  }
  if (status === "FAILED") {
    return `END Your top-up of ${formatTzs(amountCents)} could not be started. Please try again`;
  }
  return `END Processing your top-up of ${formatTzs(amountCents)}. You will receive an M-Pesa prompt shortly.`;
}

/**
 * The whole USSD session — one call per keypress. Returns the raw string
 * Africa's Talking shows the caller: "CON ..." keeps the session open for
 * another input, "END ..." closes it.
 */
export async function handleUssd(input: UssdCallback): Promise<string> {
  // sessionId keys the top-up's idempotency clientId, so an empty one would
  // make unrelated callers collide.
  if (!input.sessionId || !input.phoneNumber) return "END Invalid request";

  const steps = input.text === "" ? [] : input.text.split("*").map((s) => s.trim());

  if (steps.length === 0) return MAIN_MENU;

  switch (steps[0]) {
    case "1":
      return steps.length === 1 ? checkBalance(input.phoneNumber) : "END Invalid choice";
    case "3":
      return steps.length === 1 ? lastTransaction(input.phoneNumber) : "END Invalid choice";
    case "2": {
      if (steps.length === 1) return "CON Enter top-up amount (TZS):";
      // A bad amount re-prompts rather than ending the session, so the chain
      // can grow ("2*abc*5000") — only the latest entry is the live answer.
      const amount = parseTopupAmount(steps[steps.length - 1]);
      if (amount === null) {
        return `CON Invalid amount. Enter an amount from ${MIN_TOPUP_TZS.toLocaleString("en-US")} to ${MAX_TOPUP_TZS.toLocaleString("en-US")} (TZS):`;
      }
      return topUp(input, amount);
    }
    default:
      return "END Invalid choice";
  }
}
