"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams } from "next/navigation";
import Link from "next/link";
import { db, newLocalId } from "@/lib/db";
import { queueOp } from "@/lib/sync-engine";
import { useOnlineStatus } from "@/lib/sync-engine";
import { useTranslation } from "@/lib/use-translation";
import CameraScanner from "@/components/CameraScanner";

type ScanResult = {
  kind: "valid" | "already" | "invalid" | "refunded";
  message: string;
  ticketTypeName?: string;
  code: string;
};

export default function GateScannerPage() {
  const { eventId: rawEventId } = useParams<{ eventId: string }>();
  const eventId = decodeURIComponent(rawEventId);
  const online = useOnlineStatus();
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [result, setResult] = useState<ScanResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const event = useLiveQuery(async () => {
    const byId = await db.events.get(eventId);
    if (byId) return byId;
    return (await db.events.where("clientId").equals(eventId).first()) ?? null;
  }, [eventId]);

  const orders = useLiveQuery(async () => {
    if (!event) return [];
    return db.orders.where("eventId").equals(event.id).toArray();
  }, [event?.id]);

  const tickets = useMemo(
    () =>
      (orders ?? [])
        .filter((o) => o.status !== "REFUNDED")
        .flatMap((o) => o.tickets.map((t) => ({ ...t, orderId: o.id }))),
    [orders]
  );
  const refundedCodes = useMemo(
    () =>
      new Set(
        (orders ?? []).filter((o) => o.status === "REFUNDED").flatMap((o) => o.tickets.map((t) => t.code))
      ),
    [orders]
  );
  const checkedInCount = tickets.filter((t) => t.checkedIn).length;

  // Refs so checkIn's identity stays stable across renders — CameraScanner
  // restarts its camera stream whenever its onDetect callback changes, which
  // would otherwise happen after every single scan (tickets/orders update).
  const eventRef = useRef(event);
  eventRef.current = event;
  const ticketsRef = useRef(tickets);
  ticketsRef.current = tickets;
  const refundedCodesRef = useRef(refundedCodes);
  refundedCodesRef.current = refundedCodes;

  const checkIn = useCallback(async (rawCode: string) => {
    const normalized = rawCode.trim().toUpperCase();
    const event = eventRef.current;
    if (!normalized || !event) return;

    if (refundedCodesRef.current.has(normalized)) {
      setResult({ kind: "refunded", message: t("scan.refunded"), code: normalized });
      return;
    }

    const match = ticketsRef.current.find((tk) => tk.code === normalized);
    if (!match) {
      setResult({ kind: "invalid", message: t("scan.notFound"), code: normalized });
      return;
    }

    if (match.checkedIn) {
      setResult({ kind: "already", message: t("scan.alreadyCheckedIn"), ticketTypeName: match.ticketTypeName, code: normalized });
      return;
    }

    const order = await db.orders.get(match.orderId);
    if (!order) return;
    const scannedAt = new Date().toISOString();
    await db.orders.put({
      ...order,
      tickets: order.tickets.map((t) => (t.code === normalized ? { ...t, checkedIn: true, checkedInAt: scannedAt } : t)),
    });

    await queueOp("CHECK_IN", {
      clientId: newLocalId(),
      ticketCode: normalized,
      eventId: event.id,
      scannedAt,
    });

    setResult({ kind: "valid", message: t("scan.entryGranted"), ticketTypeName: match.ticketTypeName, code: normalized });
  }, [t]);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    checkIn(code);
    setCode("");
    inputRef.current?.focus();
  }

  if (event === undefined) {
    return <div className="mx-auto max-w-lg px-4 py-16 text-center text-muted">Loading…</div>;
  }

  if (!event) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <p className="font-semibold">Event not found on this device.</p>
        <p className="mt-2 text-sm text-muted">
          Open this event once while online so its ticket list downloads for
          offline scanning.
        </p>
        <Link href="/dashboard" className="btn-secondary mt-6 inline-flex">Back to dashboard</Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg px-4 pb-20 pt-8 sm:px-6">
      <Link href={`/dashboard/events/${event.id}`} className="text-sm text-muted hover:text-foreground">
        ← {event.title}
      </Link>

      <h1 className="mt-3 text-2xl font-bold">{t("scan.title")}</h1>
      <p className="text-sm text-muted">
        {!online && t("scan.offlinePrefix")}
        {t("scan.validatingAgainst")} {tickets.length} {tickets.length === 1 ? t("scan.ticket") : t("scan.tickets")}
      </p>

      <div className="card mt-5 flex items-center justify-between p-5">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">{t("scan.checkedIn")}</p>
          <p className="text-2xl font-bold">{checkedInCount} / {tickets.length}</p>
        </div>
        <div className="h-2 w-32 overflow-hidden rounded-full bg-surface2">
          <div
            className="h-full bg-ok transition-all"
            style={{ width: `${tickets.length ? (checkedInCount / tickets.length) * 100 : 0}%` }}
          />
        </div>
      </div>

      <div className="mt-5">
        <CameraScanner onDetect={checkIn} />
      </div>

      <form onSubmit={onSubmit} className="flex gap-2">
        <input
          ref={inputRef}
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={t("scan.enterOrScan")}
          className="input font-mono uppercase tracking-widest"
        />
        <button type="submit" className="btn-primary shrink-0">{t("scan.checkIn")}</button>
      </form>

      {result && (
        <div
          className={`mt-5 rounded-xl border p-5 text-center ${
            result.kind === "valid"
              ? "border-ok/40 bg-ok/10"
              : result.kind === "already"
              ? "border-warn/40 bg-warn/10"
              : "border-danger/40 bg-danger/10"
          }`}
        >
          <p className="font-mono text-lg font-bold tracking-widest">{result.code}</p>
          {result.ticketTypeName && <p className="text-sm text-muted">{result.ticketTypeName}</p>}
          <p
            className={`mt-1 text-lg font-semibold ${
              result.kind === "valid" ? "text-ok" : result.kind === "already" ? "text-warn" : "text-danger"
            }`}
          >
            {result.kind === "valid" ? "✓ " : result.kind === "already" ? "↻ " : "✕ "}
            {result.message}
          </p>
          {result.kind === "refunded" && (
            <p className="mt-1 text-xs text-muted">Ask the holder for a valid ticket or alternate ID.</p>
          )}
        </div>
      )}
    </div>
  );
}
