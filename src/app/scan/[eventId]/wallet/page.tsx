"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { db, newLocalId } from "@/lib/db";
import { queueOp, flushOutbox, useOnlineStatus } from "@/lib/sync-engine";
import { useAppSession } from "@/lib/use-app-session";
import { formatCents } from "@/lib/format";
import CameraScanner from "@/components/CameraScanner";
import NFCScanner from "@/components/NFCScanner";

type TerminalResult = {
  kind: "valid" | "declined" | "invalid" | "offline" | "recorded";
  message: string;
  code: string;
};

export default function WalletChargeTerminalPage() {
  const { eventId: rawEventId } = useParams<{ eventId: string }>();
  const eventId = decodeURIComponent(rawEventId);
  const router = useRouter();
  const { user, status } = useAppSession();
  const online = useOnlineStatus();

  // Previously this page had no auth check at all. Middleware already
  // redirects GATE_CREW away from this route server-side; this covers the
  // baseline "must be signed in" case and the offline-cached-shell case
  // (see src/middleware.ts).
  useEffect(() => {
    if (status !== "loading" && !user) router.push(`/login?callbackUrl=/scan/${eventId}/wallet`);
    if (user?.organizationRole === "GATE_CREW") router.replace("/dashboard");
  }, [status, user, router, eventId]);
  const [mode, setMode] = useState<"sale" | "tap">("sale");
  const [code, setCode] = useState("");
  const [amountMajor, setAmountMajor] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [sponsorId, setSponsorId] = useState("");
  const [note, setNote] = useState("");
  const [showNoteField, setShowNoteField] = useState(false);
  const [result, setResult] = useState<TerminalResult | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const event = useLiveQuery(async () => {
    const byId = await db.events.get(eventId);
    if (byId) return byId;
    return (await db.events.where("clientId").equals(eventId).first()) ?? null;
  }, [eventId]);

  const vendors = useLiveQuery(async () => {
    if (!event) return [];
    return db.vendors.where("eventId").equals(event.id).toArray();
  }, [event?.id]);
  const approvedVendors = useMemo(() => (vendors ?? []).filter((v) => v.status === "APPROVED"), [vendors]);

  const sponsors = useLiveQuery(async () => {
    if (!event) return [];
    return db.sponsors.where("eventId").equals(event.id).toArray();
  }, [event?.id]);

  // Refs so the scan handlers' identity stays stable across renders —
  // CameraScanner restarts its stream whenever onDetect changes, same
  // reasoning as the gate scanner's ref-stabilization.
  const eventRef = useRef(event);
  eventRef.current = event;
  const vendorIdRef = useRef(vendorId);
  vendorIdRef.current = vendorId;
  const amountMajorRef = useRef(amountMajor);
  amountMajorRef.current = amountMajor;
  const sponsorIdRef = useRef(sponsorId);
  sponsorIdRef.current = sponsorId;
  const noteRef = useRef(note);
  noteRef.current = note;
  const onlineRef = useRef(online);
  onlineRef.current = online;

  const chargeWallet = useCallback(async (rawCode: string) => {
    const normalized = rawCode.trim().toUpperCase();
    const event = eventRef.current;
    if (!normalized || !event) return;

    if (!onlineRef.current) {
      setResult({ kind: "offline", message: "Charging requires an online connection.", code: normalized });
      return;
    }
    const vendorId = vendorIdRef.current;
    const amountCents = Math.round(parseFloat(amountMajorRef.current || "0") * 100);
    if (!vendorId) {
      setResult({ kind: "invalid", message: "Pick which vendor you're charging for first.", code: normalized });
      return;
    }
    if (!amountCents || amountCents < 1) {
      setResult({ kind: "invalid", message: "Enter an amount first.", code: normalized });
      return;
    }

    setBusy(true);
    const clientId = newLocalId();
    // Deliberately not optimistic — unlike a ticket/badge check-in, a
    // declined-after-the-fact charge is a real loss to the vendor, so this
    // waits for the server's actual answer instead of showing "approved"
    // before it's confirmed.
    await queueOp("CHARGE_WALLET", {
      clientId,
      walletCode: normalized,
      vendorId,
      eventId: event.id,
      eventClientId: event.clientId,
      amountCents,
    });
    await flushOutbox();
    const tx = await db.walletTransactions.where("clientId").equals(clientId).first();
    setBusy(false);

    if (!tx) {
      setResult({ kind: "invalid", message: "Couldn't reach the server — check your connection and try again.", code: normalized });
      return;
    }
    if (tx.status === "FAILED") {
      setResult({ kind: "declined", message: "Declined — insufficient balance.", code: normalized });
      return;
    }
    if (tx.status === "COMPLETED") {
      setResult({ kind: "valid", message: `Charged ${formatCents(amountCents, tx.currency)}.`, code: normalized });
      return;
    }
    setResult({ kind: "invalid", message: "Couldn't confirm this charge — try again.", code: normalized });
  }, []);

  const recordTap = useCallback(async (rawCode: string) => {
    const normalized = rawCode.trim().toUpperCase();
    const event = eventRef.current;
    const sponsorId = sponsorIdRef.current;
    if (!normalized || !event) return;
    if (!sponsorId) {
      setResult({ kind: "invalid", message: "Pick which sponsor this tap is for first.", code: normalized });
      return;
    }

    const clientId = newLocalId();
    await queueOp("SPONSOR_TAP", {
      clientId,
      walletCode: normalized,
      sponsorId,
      eventId: event.id,
      eventClientId: event.clientId,
      note: noteRef.current.trim() || undefined,
    });

    setResult({ kind: "recorded", message: "Tap recorded.", code: normalized });
    // Reset for the next attendee — same discipline as the code input reset
    // in onSubmit below, applied here too since scanner-triggered taps
    // (CameraScanner/NFCScanner) bypass onSubmit entirely.
    setNote("");
    setShowNoteField(false);
  }, []);

  const activeHandler = mode === "sale" ? chargeWallet : recordTap;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    activeHandler(code);
    setCode("");
    inputRef.current?.focus();
  }

  if (!user || user.organizationRole === "GATE_CREW") return null;

  if (event === undefined) {
    return <div className="mx-auto max-w-lg px-4 py-16 text-center text-muted">Loading…</div>;
  }
  if (!event) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <p className="font-semibold">Event not found on this device.</p>
        <Link href="/dashboard" className="btn-secondary mt-6 inline-flex">Back to dashboard</Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg px-4 pb-20 pt-8 sm:px-6">
      <Link href={`/scan/${event.id}`} className="text-sm text-muted hover:text-foreground">
        ← {event.title} gate scanner
      </Link>
      <h1 className="mt-3 text-2xl font-bold">Wallet charge terminal</h1>

      <div className="mt-4 flex gap-2">
        <button
          className={mode === "sale" ? "btn-primary" : "btn-secondary"}
          onClick={() => { setMode("sale"); setResult(null); }}
        >
          Vendor sale
        </button>
        <button
          className={mode === "tap" ? "btn-primary" : "btn-secondary"}
          onClick={() => { setMode("tap"); setResult(null); }}
        >
          Sponsor tap
        </button>
      </div>

      {!online && mode === "sale" && (
        <p className="mt-3 text-sm text-warn">Charging requires an online connection — reconnect to continue.</p>
      )}

      {mode === "sale" ? (
        <div className="card mt-5 space-y-4 p-5">
          <div>
            <label className="label" htmlFor="vendor">Charging as</label>
            <select id="vendor" className="input" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">Select a vendor…</option>
              {approvedVendors.map((v) => (
                <option key={v.id} value={v.id}>{v.name}{v.boothNumber ? ` (Booth ${v.boothNumber})` : ""}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="amount">Amount ({event.currency})</label>
            <input
              id="amount"
              type="number"
              min="1"
              step="500"
              className="input"
              value={amountMajor}
              onChange={(e) => setAmountMajor(e.target.value)}
            />
          </div>
        </div>
      ) : (
        <div className="card mt-5 space-y-3 p-5">
          <div>
            <label className="label" htmlFor="sponsor">Sponsor</label>
            <select id="sponsor" className="input" value={sponsorId} onChange={(e) => setSponsorId(e.target.value)}>
              <option value="">Select a sponsor…</option>
              {(sponsors ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.name} ({s.tier})</option>
              ))}
            </select>
          </div>
          {showNoteField ? (
            <div>
              <label className="label" htmlFor="tapNote">Note (optional)</label>
              <textarea
                id="tapNote"
                className="input min-h-16"
                placeholder="e.g. interested in the Series A demo"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
              />
            </div>
          ) : (
            <button
              type="button"
              className="text-xs font-medium text-accent-hover"
              onClick={() => setShowNoteField(true)}
            >
              + Add a note
            </button>
          )}
        </div>
      )}

      <div className="mt-5">
        <CameraScanner onDetect={activeHandler} />
        <NFCScanner onDetect={activeHandler} />
      </div>

      <form onSubmit={onSubmit} className="flex gap-2">
        <input
          ref={inputRef}
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Enter or scan wallet code"
          className="input font-mono uppercase tracking-widest"
        />
        <button type="submit" disabled={busy} className="btn-primary shrink-0">
          {busy ? "…" : mode === "sale" ? "Charge" : "Record tap"}
        </button>
      </form>

      {result && (
        <div
          className={`mt-5 rounded-xl border p-5 text-center ${
            result.kind === "valid" || result.kind === "recorded"
              ? "border-ok/40 bg-ok/10"
              : result.kind === "declined" || result.kind === "offline"
              ? "border-warn/40 bg-warn/10"
              : "border-danger/40 bg-danger/10"
          }`}
        >
          <p className="font-mono text-lg font-bold tracking-widest">{result.code}</p>
          <p
            className={`mt-1 text-lg font-semibold ${
              result.kind === "valid" || result.kind === "recorded"
                ? "text-ok"
                : result.kind === "declined" || result.kind === "offline"
                ? "text-warn"
                : "text-danger"
            }`}
          >
            {result.kind === "valid" || result.kind === "recorded" ? "✓ " : "✕ "}
            {result.message}
          </p>
        </div>
      )}
    </div>
  );
}
