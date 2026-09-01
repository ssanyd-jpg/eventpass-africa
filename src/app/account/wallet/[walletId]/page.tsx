"use client";

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { db, newLocalId } from "@/lib/db";
import { queueOp } from "@/lib/sync-engine";
import { useAppSession } from "@/lib/use-app-session";
import { formatCents, formatDateTime } from "@/lib/format";
import TicketQr from "@/components/TicketQr";

const NETWORKS = [
  { value: "MPESA", label: "M-Pesa" },
  { value: "TIGO", label: "Tigo Pesa" },
  { value: "AIRTEL", label: "Airtel Money" },
  { value: "HALOTEL", label: "HaloPesa" },
];

const STATUS_STYLE: Record<string, string> = {
  COMPLETED: "border-ok/40 bg-ok/10 text-ok",
  PENDING: "border-warn/40 bg-warn/10 text-warn",
  FAILED: "border-danger/40 bg-danger/10 text-danger",
};

const TYPE_LABEL: Record<string, string> = {
  TOPUP: "Top-up",
  SALE: "Purchase",
  SPONSOR_TAP: "Sponsor tap",
  WITHDRAWAL: "Withdrawal",
};

interface NDEFWriterLike {
  write(message: { records: { recordType: string; data: string }[] }): Promise<void>;
}
declare global {
  interface Window {
    NDEFWriter?: new () => NDEFWriterLike;
  }
}

export default function WalletDetailPage() {
  const { walletId } = useParams<{ walletId: string }>();
  const router = useRouter();
  const { user, status } = useAppSession();

  const wallet = useLiveQuery(async () => db.wallets.get(walletId), [walletId]);
  const event = useLiveQuery(async () => (wallet ? db.events.get(wallet.eventId) : undefined), [wallet?.eventId]);
  const transactions = useLiveQuery(async () => {
    const all = await db.walletTransactions.where("walletId").equals(walletId).toArray();
    return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }, [walletId]);

  const [amountMajor, setAmountMajor] = useState("");
  const [phone, setPhone] = useState("");
  const [network, setNetwork] = useState(NETWORKS[0].value);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nfcSupported, setNfcSupported] = useState(false);
  const [nfcStatus, setNfcStatus] = useState<string | null>(null);

  const [wAmountMajor, setWAmountMajor] = useState("");
  const [wPhone, setWPhone] = useState("");
  const [wNetwork, setWNetwork] = useState(NETWORKS[0].value);
  const [wSubmitting, setWSubmitting] = useState(false);
  const [wError, setWError] = useState<string | null>(null);

  useEffect(() => {
    setNfcSupported(typeof window !== "undefined" && "NDEFWriter" in window);
  }, []);

  useEffect(() => {
    if (status !== "loading" && !user) router.push(`/login?callbackUrl=/account/wallet/${walletId}`);
  }, [status, user, router, walletId]);

  // Auto-check any pending top-up once, on load.
  useEffect(() => {
    const pending = (transactions ?? []).find((t) => t.type === "TOPUP" && t.status === "PENDING");
    if (pending) checkStatus(pending.id, pending.clientId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions?.length]);

  if (!user) return null;

  if (wallet === undefined) {
    return <div className="mx-auto max-w-lg px-4 py-16 text-center text-muted">Loading…</div>;
  }
  if (!wallet) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <p className="font-semibold">Wallet not found on this device.</p>
        <Link href="/account/wallet" className="btn-secondary mt-6 inline-flex">← My Wallets</Link>
      </div>
    );
  }

  const eventCancelled = event?.status === "CANCELLED";

  async function checkStatus(walletTransactionId: string, walletTransactionClientId?: string | null) {
    await queueOp("CHECK_TOPUP_STATUS", {
      clientId: newLocalId(),
      walletTransactionId,
      walletTransactionClientId,
    });
  }

  async function bindNfc() {
    if (!wallet) return;
    setNfcStatus(null);
    try {
      const writer = new window.NDEFWriter!();
      await writer.write({ records: [{ recordType: "text", data: wallet.code }] });
      setNfcStatus("Wristband bound successfully.");
    } catch {
      setNfcStatus("Couldn't write to a tag — hold a writable NFC tag near the device and try again.");
    }
  }

  async function topUp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!wallet || eventCancelled) return;
    const amountCents = Math.round(parseFloat(amountMajor || "0") * 100);
    if (!amountCents || amountCents < 100) {
      setError("Enter an amount of at least 1.00.");
      return;
    }
    setSubmitting(true);

    const clientId = newLocalId();
    await db.walletTransactions.put({
      id: clientId,
      clientId,
      walletId: wallet.id,
      type: "TOPUP",
      status: "PENDING",
      amountCents,
      currency: wallet.currency,
      providerReference: null,
      providerMessage: "Test checkout — no real payment is processed.",
      phoneNumber: phone.trim() || null,
      mobileNetwork: null,
      note: null,
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

    await queueOp("TOPUP_WALLET", {
      clientId,
      walletId: wallet.id,
      walletClientId: wallet.clientId,
      amountCents,
      phoneNumber: phone.trim() || undefined,
      mobileNetwork: network,
    });

    setAmountMajor("");
    setSubmitting(false);
  }

  // Unlike top-up's optimistic UI (which only writes the pending tx row and
  // never touches the balance, since a real provider charge can genuinely
  // still be pending), a withdrawal's balance change is certain the
  // instant it's requested — the server does the same CAS-decrement
  // synchronously (handleWithdrawWallet), not pending on an async provider
  // callback — so the local balance is decremented optimistically here too,
  // corrected by the server-authoritative row once synced.
  async function withdraw(e: React.FormEvent) {
    e.preventDefault();
    setWError(null);
    if (!wallet) return;
    const amountCents = Math.round(parseFloat(wAmountMajor || "0") * 100);
    if (!amountCents || amountCents < 100) {
      setWError("Enter an amount of at least 1.00.");
      return;
    }
    if (amountCents > wallet.balanceCents) {
      setWError("You can't withdraw more than your balance.");
      return;
    }
    if (!wPhone.trim()) {
      setWError("Enter the phone number to receive the payout.");
      return;
    }
    setWSubmitting(true);

    const clientId = newLocalId();
    await db.wallets.put({ ...wallet, balanceCents: wallet.balanceCents - amountCents, syncStatus: "pending" });
    await db.walletTransactions.put({
      id: clientId,
      clientId,
      walletId: wallet.id,
      type: "WITHDRAWAL",
      status: "PENDING",
      amountCents,
      currency: wallet.currency,
      providerReference: null,
      providerMessage: null,
      phoneNumber: wPhone.trim(),
      mobileNetwork: wNetwork,
      note: null,
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

    await queueOp("WITHDRAW_WALLET", {
      clientId,
      walletId: wallet.id,
      walletClientId: wallet.clientId,
      amountCents,
      phoneNumber: wPhone.trim(),
      mobileNetwork: wNetwork,
    });

    setWAmountMajor("");
    setWPhone("");
    setWSubmitting(false);
  }

  return (
    <div className="mx-auto max-w-lg px-4 pb-20 pt-8 sm:px-6">
      <Link href="/account/wallet" className="text-sm text-muted hover:text-foreground">← My Wallets</Link>
      <h1 className="mb-1 mt-3 text-2xl font-bold">{event?.title ?? "Wallet"}</h1>

      <div className="card mt-4 flex flex-col items-center gap-3 p-6 text-center">
        <p className="text-xs uppercase tracking-wide text-muted">Balance</p>
        <p className="text-3xl font-bold">{formatCents(wallet.balanceCents, wallet.currency)}</p>
        <TicketQr code={wallet.code} />
        <p className="font-mono text-sm">{wallet.code}</p>
        {wallet.syncStatus === "pending" && (
          <span className="pill border-warn/40 bg-warn/10 text-warn">Pending sync</span>
        )}
        {nfcSupported && (
          <button className="btn-secondary mt-2 w-full" onClick={bindNfc}>
            Bind to NFC wristband
          </button>
        )}
        {nfcStatus && <p className="text-xs text-muted">{nfcStatus}</p>}
      </div>

      {eventCancelled ? (
        <div className="card mt-6 p-5">
          <p className="font-semibold text-danger">This event was cancelled.</p>
          <p className="mt-2 text-sm text-muted">
            Your remaining balance of {formatCents(wallet.balanceCents, wallet.currency)} can&apos;t
            be spent anymore, but you can still withdraw it below.
          </p>
        </div>
      ) : (
        <form onSubmit={topUp} className="card mt-6 space-y-4 p-6">
          <h2 className="font-semibold">Top up</h2>
          <div>
            <label className="label" htmlFor="amount">Amount ({wallet.currency})</label>
            <input
              id="amount"
              type="number"
              min="1"
              step="500"
              className="input"
              value={amountMajor}
              onChange={(e) => setAmountMajor(e.target.value)}
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label" htmlFor="network">Network</label>
              <select id="network" className="input" value={network} onChange={(e) => setNetwork(e.target.value)}>
                {NETWORKS.map((n) => (
                  <option key={n.value} value={n.value}>{n.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="phone">Phone number</label>
              <input id="phone" className="input" placeholder="+255 7XX XXX XXX" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
          </div>
          <div className="rounded-lg border border-border bg-surface2 p-3 text-xs text-muted">
            Test checkout — no real payment is processed. Top-ups complete
            instantly, even offline, and sync automatically when connected.
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <button type="submit" disabled={submitting} className="btn-primary w-full">
            {submitting ? "Submitting…" : "Top up"}
          </button>
        </form>
      )}

      {wallet.balanceCents > 0 && (
        <form onSubmit={withdraw} className="card mt-6 space-y-4 p-6">
          <h2 className="font-semibold">Withdraw</h2>
          <p className="text-xs text-muted">
            Cash out any of your remaining balance. An organizer reviews
            requests and pays you out via mobile money — this usually isn&apos;t
            instant.
          </p>
          <div>
            <label className="label" htmlFor="wAmount">Amount ({wallet.currency})</label>
            <input
              id="wAmount"
              type="number"
              min="1"
              // No step here — unlike top-up (which has no natural upper
              // bound, so a step:500 spinner is a convenience), a
              // withdrawal is capped at the current balance, which is
              // often small. A fixed step could make it impossible to
              // enter a valid amount at all (e.g. a step-500 field with a
              // sub-500 balance has no valid non-zero value).
              max={wallet.balanceCents / 100}
              className="input"
              value={wAmountMajor}
              onChange={(e) => setWAmountMajor(e.target.value)}
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label" htmlFor="wNetwork">Network</label>
              <select id="wNetwork" className="input" value={wNetwork} onChange={(e) => setWNetwork(e.target.value)}>
                {NETWORKS.map((n) => (
                  <option key={n.value} value={n.value}>{n.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="wPhone">Phone number</label>
              <input
                id="wPhone"
                className="input"
                placeholder="+255 7XX XXX XXX"
                value={wPhone}
                onChange={(e) => setWPhone(e.target.value)}
                required
              />
            </div>
          </div>
          {wError && <p className="text-sm text-danger">{wError}</p>}
          <button type="submit" disabled={wSubmitting} className="btn-secondary w-full">
            {wSubmitting ? "Submitting…" : "Request withdrawal"}
          </button>
        </form>
      )}

      <h2 className="mb-3 mt-8 font-semibold">Transaction history</h2>
      {(transactions ?? []).length === 0 ? (
        <div className="card p-8 text-center text-muted">No activity yet.</div>
      ) : (
        <div className="card divide-y divide-border">
          {(transactions ?? []).map((t) => (
            <div key={t.id} className="flex items-center justify-between p-4 text-sm">
              <div>
                <p className="font-medium">
                  {TYPE_LABEL[t.type] ?? t.type}
                  {t.vendorName ? ` — ${t.vendorName}` : ""}
                  {t.sponsorName ? ` — ${t.sponsorName}` : ""}
                </p>
                <p className="text-xs text-muted">{formatDateTime(t.createdAt)}</p>
                {t.status === "PENDING" && t.type === "TOPUP" && (
                  <button
                    className="mt-1 text-xs font-medium text-accent-hover"
                    onClick={() => checkStatus(t.id, t.clientId)}
                  >
                    Check status
                  </button>
                )}
                {t.status === "PENDING" && t.type === "WITHDRAWAL" && (
                  <p className="mt-1 text-xs text-muted">Waiting for organizer review</p>
                )}
              </div>
              <div className="text-right">
                {t.amountCents !== null && (
                  <p className="font-semibold">
                    {t.type === "TOPUP" ? "+" : "-"}{formatCents(t.amountCents, t.currency)}
                  </p>
                )}
                <span className={`pill ${STATUS_STYLE[t.status] ?? ""}`}>{t.status}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
