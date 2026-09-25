"use client";

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { db, newLocalId } from "@/lib/db";
import { queueOp } from "@/lib/sync-engine";
import { useAppSession } from "@/lib/use-app-session";
import { formatCents } from "@/lib/format";
import { MIN_TRANSFER_CENTS, MAX_TRANSFER_CENTS } from "@/lib/wallet-transfer-limits";
import NFCScanner from "@/components/NFCScanner";
import { SkeletonPage } from "@/components/Skeleton";

// Session 37 — the send side of peer-to-peer wallet transfers.
//
// Flow: pick a method → enter the amount and identify the recipient → confirm
// (the recipient's FIRST NAME only, never their full name/phone) → success.
// Confirming queues two outbox ops, INITIATE_WALLET_TRANSFER then
// COMPLETE_WALLET_TRANSFER; they share the sender's outbox bucket, so they
// run strictly in that order. The result screen reads the sender's own
// TRANSFER_OUT row out of Dexie rather than awaiting a response, which is
// what lets an offline code entry sit queued and resolve when the device
// reconnects.

type Method = "NFC" | "CODE" | "PHONE";
type Step = "method" | "details" | "confirm" | "result";

interface Recipient {
  walletId: string;
  // null only for an offline code entry: the code can't be resolved (and so
  // the name can't be shown) until the op syncs.
  firstName: string | null;
}

const RESOLVE_ERRORS: Record<string, string> = {
  RECIPIENT_NOT_FOUND: "We couldn't find a wallet for that recipient at this event.",
  INVALID_CODE: "That code isn't valid. Check it with the person you're paying.",
  CODE_EXPIRED: "That code has expired. Ask them to generate a new one.",
  SELF_TRANSFER: "You can't send money to yourself.",
  DIFFERENT_EVENT: "That wristband belongs to a different event.",
  TRANSFERS_DISABLED: "The organiser hasn't enabled wallet transfers for this event.",
  EVENT_NOT_LIVE: "This event isn't live, so transfers are unavailable.",
  CURRENCY_NOT_SUPPORTED: "Transfers aren't available for this event's currency.",
  RATE_LIMITED: "Too many attempts. Wait a minute and try again.",
};

function useOnline() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}

export default function WalletTransferPage() {
  const { walletId } = useParams<{ walletId: string }>();
  const router = useRouter();
  const { user, status } = useAppSession();
  const online = useOnline();

  const wallet = useLiveQuery(async () => db.wallets.get(walletId), [walletId]);
  const event = useLiveQuery(async () => (wallet ? db.events.get(wallet.eventId) : undefined), [wallet?.eventId]);

  const [step, setStep] = useState<Step>("method");
  const [method, setMethod] = useState<Method | null>(null);
  const [amountMajor, setAmountMajor] = useState("");
  const [code, setCode] = useState("");
  const [phone, setPhone] = useState("");
  const [nfcUid, setNfcUid] = useState<string | null>(null);
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initiateClientId, setInitiateClientId] = useState<string | null>(null);

  // The sender's own TRANSFER_OUT row, found by the INITIATE op's clientId.
  // Before the op syncs it's the local placeholder (id === clientId); after,
  // the server row that replaced it (same clientId).
  const outgoing = useLiveQuery(
    async () => {
      if (!initiateClientId) return undefined;
      const rows = await db.walletTransactions.where("walletId").equals(walletId).toArray();
      return rows.find((t) => t.clientId === initiateClientId) ?? null;
    },
    [initiateClientId, walletId]
  );

  useEffect(() => {
    if (status !== "loading" && !user) router.push(`/login?callbackUrl=/account/wallet/${walletId}/transfer`);
  }, [status, user, router, walletId]);

  if (!user) return null;
  if (wallet === undefined) return <SkeletonPage maxWidth="max-w-lg" />;
  if (!wallet) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <p className="font-semibold">Wallet not found on this device.</p>
        <Link href="/account/wallet" className="btn-secondary mt-6 inline-flex">← My Wallets</Link>
      </div>
    );
  }

  const w = wallet;
  const transfersOn = event?.transferEnabled === true && event.status !== "CANCELLED" && w.currency === "TZS";
  const amountCents = Math.round(parseFloat(amountMajor || "0") * 100);

  function validateAmount(): string | null {
    if (!amountCents) return "Enter an amount to send.";
    if (amountCents < MIN_TRANSFER_CENTS) return `The minimum transfer is ${formatCents(MIN_TRANSFER_CENTS, w.currency)}.`;
    if (amountCents > MAX_TRANSFER_CENTS) return `The maximum single transfer is ${formatCents(MAX_TRANSFER_CENTS, w.currency)}.`;
    if (amountCents > w.balanceCents) return "You can't send more than your balance.";
    return null;
  }

  function chooseMethod(next: Method) {
    setError(null);
    setNfcUid(null);
    setRecipient(null);
    setMethod(next);
    setStep("details");
  }

  async function resolve(body: Record<string, string>): Promise<Recipient | null> {
    const res = await fetch("/api/wallet-transfer/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderWalletId: w.id, ...body }),
    });
    const json = await res.json().catch(() => null);
    if (!json?.ok) {
      setError(RESOLVE_ERRORS[json?.reason] ?? "Couldn't look up that recipient. Check your connection and try again.");
      return null;
    }
    return { walletId: json.recipient.walletId, firstName: json.recipient.firstName };
  }

  async function continueToConfirm() {
    setError(null);
    const amountError = validateAmount();
    if (amountError) return setError(amountError);
    if (!method) return;

    // A code is the one identifier that can be entered with no connection —
    // it's resolved when the queued op syncs, so there's no name to confirm.
    if (method === "CODE" && !online) {
      if (!/^\d{6}$/.test(code.trim())) return setError("Enter the 6-digit code.");
      setRecipient({ walletId: "", firstName: null });
      return setStep("confirm");
    }
    if (!online) return setError("Transfers require a connection — use the transfer code method instead.");

    setBusy(true);
    let resolved: Recipient | null = null;
    if (method === "CODE") {
      if (!/^\d{6}$/.test(code.trim())) {
        setBusy(false);
        return setError("Enter the 6-digit code.");
      }
      resolved = await resolve({ method: "CODE", code: code.trim() });
    } else if (method === "PHONE") {
      if (!phone.trim()) {
        setBusy(false);
        return setError("Enter the recipient's phone number.");
      }
      resolved = await resolve({ method: "PHONE", phone: phone.trim() });
    } else if (nfcUid) {
      resolved = await resolve({ method: "NFC", nfcUid });
    } else {
      setBusy(false);
      return setError("Tap the recipient's wristband first.");
    }
    setBusy(false);
    if (resolved) {
      setRecipient(resolved);
      setStep("confirm");
    }
  }

  // An NFC tap resolves immediately (when the amount is already valid) so
  // the sender goes straight to the confirmation screen.
  async function onNfcDetect(uid: string | null) {
    if (step !== "details" || method !== "NFC" || !uid) return;
    setNfcUid(uid);
    setError(null);
    const amountError = validateAmount();
    if (amountError) return setError(`Wristband read. ${amountError}`);
    if (!online) return setError("Transfers require a connection — use the transfer code method instead.");
    setBusy(true);
    const resolved = await resolve({ method: "NFC", nfcUid: uid });
    setBusy(false);
    if (resolved) {
      setRecipient(resolved);
      setStep("confirm");
    }
  }

  async function confirm() {
    if (!method || !recipient) return;
    setBusy(true);
    const clientId = newLocalId();

    // The local placeholder is keyed by the INITIATE op's clientId, which the
    // server also stamps on the TRANSFER_OUT row — so applying the result
    // replaces exactly this row. The balance is NOT touched optimistically:
    // unlike a withdrawal, a transfer can still be declined server-side
    // (expired code, unknown recipient), and the server's answer patches it.
    await db.walletTransactions.put({
      id: clientId,
      clientId,
      walletId: w.id,
      type: "TRANSFER_OUT",
      status: "PENDING",
      amountCents,
      currency: w.currency,
      providerReference: null,
      providerMessage: null,
      phoneNumber: null,
      mobileNetwork: null,
      note: recipient.firstName,
      item: null,
      spentByTicketId: null,
      spentByMemberName: null,
      vendorId: null,
      vendorName: null,
      sponsorId: null,
      sponsorName: null,
      campaignId: null,
      campaignName: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      syncStatus: "pending",
    });

    await queueOp("INITIATE_WALLET_TRANSFER", {
      clientId,
      senderWalletId: w.id,
      senderWalletClientId: w.clientId,
      method,
      amountCents,
      ...(method === "NFC" ? { nfcUid } : {}),
      ...(method === "CODE" ? { code: code.trim() } : {}),
      ...(method === "PHONE" ? { phone: phone.trim() } : {}),
    });
    await queueOp("COMPLETE_WALLET_TRANSFER", {
      clientId: newLocalId(),
      senderWalletId: w.id,
      senderWalletClientId: w.clientId,
      initiateClientId: clientId,
    });

    setInitiateClientId(clientId);
    setBusy(false);
    setStep("result");
  }

  function reset() {
    setStep("method");
    setMethod(null);
    setAmountMajor("");
    setCode("");
    setPhone("");
    setNfcUid(null);
    setRecipient(null);
    setInitiateClientId(null);
    setError(null);
  }

  return (
    <div className="mx-auto max-w-lg px-4 pb-20 pt-8 sm:px-6">
      <Link href={`/account/wallet/${walletId}`} className="text-sm text-muted hover:text-foreground">← Back to wallet</Link>
      <h1 className="mb-1 mt-3 text-2xl font-bold">Send money</h1>
      <p className="text-sm text-muted">
        Balance: <span className="font-semibold text-foreground">{formatCents(w.balanceCents, w.currency)}</span>
        {event?.title ? ` · ${event.title}` : ""}
      </p>

      {!transfersOn ? (
        <div className="card mt-6 p-5">
          <p className="font-semibold">Transfers aren&apos;t available for this event.</p>
          <p className="mt-2 text-sm text-muted">
            The organiser needs to turn on wallet transfers. Until then you can still top up and spend as usual.
          </p>
        </div>
      ) : step === "method" ? (
        <div className="mt-6 space-y-3">
          <p className="text-sm font-medium">How do you want to find the person you&apos;re paying?</p>
          <button className="card w-full p-4 text-left" onClick={() => chooseMethod("NFC")}>
            <p className="font-semibold">Tap their wristband</p>
            <p className="text-xs text-muted">In person. Hold your phone to their NFC wristband. Needs a connection.</p>
          </button>
          <button className="card w-full p-4 text-left" onClick={() => chooseMethod("CODE")}>
            <p className="font-semibold">Enter their transfer code</p>
            <p className="text-xs text-muted">They tap &ldquo;Receive&rdquo; on their wallet and read you a 6-digit code (valid 15 minutes).</p>
          </button>
          <button className="card w-full p-4 text-left" onClick={() => chooseMethod("PHONE")}>
            <p className="font-semibold">Use their phone number</p>
            <p className="text-xs text-muted">Works if they registered a wallet for this event with that number. Needs a connection.</p>
          </button>
        </div>
      ) : step === "details" ? (
        <div className="card mt-6 space-y-4 p-6">
          <div>
            <label className="label" htmlFor="amount">Amount ({w.currency})</label>
            <input
              id="amount"
              type="number"
              inputMode="decimal"
              min={MIN_TRANSFER_CENTS / 100}
              max={Math.min(MAX_TRANSFER_CENTS, w.balanceCents) / 100}
              className="input"
              value={amountMajor}
              onChange={(e) => setAmountMajor(e.target.value)}
            />
            <p className="mt-1 text-xs text-muted">
              {formatCents(MIN_TRANSFER_CENTS, w.currency)} – {formatCents(MAX_TRANSFER_CENTS, w.currency)} per transfer.
            </p>
          </div>

          {method === "NFC" && (
            <div>
              {!online && (
                <p className="mb-3 rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm text-warn">
                  Transfers require a connection — use the transfer code method instead.
                </p>
              )}
              <NFCScanner onDetect={(reading) => onNfcDetect(reading.uid)} />
              {nfcUid && <p className="text-xs text-muted">Wristband read.</p>}
              <p className="text-xs text-muted">
                NFC needs Chrome on Android. If your phone can&apos;t read wristbands, go back and use a code or phone
                number.
              </p>
            </div>
          )}

          {method === "CODE" && (
            <div>
              <label className="label" htmlFor="code">Transfer code</label>
              <input
                id="code"
                inputMode="numeric"
                maxLength={6}
                className="input font-mono text-lg tracking-widest"
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              />
              {!online && (
                <p className="mt-2 text-xs text-muted">
                  You&apos;re offline. The code will be sent when you reconnect — if it has expired by then, nothing is
                  sent and your money stays put.
                </p>
              )}
            </div>
          )}

          {method === "PHONE" && (
            <div>
              <label className="label" htmlFor="phone">Recipient&apos;s phone number</label>
              <input
                id="phone"
                className="input"
                placeholder="+255 7XX XXX XXX"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
              {!online && (
                <p className="mt-2 rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm text-warn">
                  Transfers require a connection — use the transfer code method instead.
                </p>
              )}
            </div>
          )}

          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex gap-3">
            <button className="btn-secondary flex-1" onClick={() => setStep("method")}>Back</button>
            {method !== "NFC" && (
              <button className="btn-primary flex-1" disabled={busy} onClick={continueToConfirm}>
                {busy ? "Checking…" : "Continue"}
              </button>
            )}
          </div>
        </div>
      ) : step === "confirm" && recipient ? (
        <div className="card mt-6 space-y-4 p-6 text-center">
          <p className="text-sm text-muted">You&apos;re about to send</p>
          <p className="text-3xl font-bold">{formatCents(amountCents, w.currency)}</p>
          {recipient.firstName ? (
            <p className="text-lg">
              to <span className="font-semibold">{recipient.firstName}</span>
            </p>
          ) : (
            <p className="text-sm text-muted">
              The recipient&apos;s name will be confirmed once you&apos;re back online. If the code is no longer valid
              nothing is sent.
            </p>
          )}
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex gap-3">
            <button className="btn-secondary flex-1" disabled={busy} onClick={() => setStep("details")}>Back</button>
            <button className="btn-primary flex-1" disabled={busy} onClick={confirm}>
              {busy ? "Sending…" : "Confirm & send"}
            </button>
          </div>
        </div>
      ) : (
        <ResultCard
          outgoing={outgoing}
          currency={w.currency}
          online={online}
          onAnother={reset}
          walletId={walletId}
        />
      )}
    </div>
  );
}

function ResultCard({
  outgoing,
  currency,
  online,
  onAnother,
  walletId,
}: {
  outgoing: { status: string; syncStatus: string; syncError?: string | null; amountCents: number | null; note: string | null } | null | undefined;
  currency: string;
  online: boolean;
  onAnother: () => void;
  walletId: string;
}) {
  const failed = outgoing?.syncStatus === "conflict" || outgoing?.status === "FAILED";
  const done = outgoing?.status === "COMPLETED" && outgoing.syncStatus === "synced";

  if (failed) {
    return (
      <div className="card mt-6 space-y-3 p-6 text-center">
        <p className="text-lg font-semibold text-danger">Transfer not sent</p>
        <p className="text-sm text-muted">{outgoing?.syncError ?? "The transfer couldn't be completed. Your money was not taken."}</p>
        <button className="btn-primary w-full" onClick={onAnother}>Try again</button>
      </div>
    );
  }
  if (done) {
    return (
      <div className="card mt-6 space-y-3 p-6 text-center">
        <p className="text-lg font-semibold text-ok">Sent</p>
        <p className="text-2xl font-bold">{formatCents(outgoing?.amountCents ?? 0, currency)}</p>
        {outgoing?.note && <p className="text-muted">to {outgoing.note}</p>}
        <div className="flex gap-3">
          <button className="btn-secondary flex-1" onClick={onAnother}>Send another</button>
          <Link href={`/account/wallet/${walletId}`} className="btn-primary inline-flex flex-1 items-center justify-center">Done</Link>
        </div>
      </div>
    );
  }
  return (
    <div className="card mt-6 space-y-3 p-6 text-center">
      <p className="text-lg font-semibold">{online ? "Sending…" : "Queued"}</p>
      <p className="text-sm text-muted">
        {online
          ? "This usually takes a few seconds."
          : "You're offline. The transfer will be sent automatically when you reconnect — nothing has left your balance yet."}
      </p>
    </div>
  );
}
