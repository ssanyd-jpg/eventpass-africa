"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { db, newLocalId, type LocalChipTime } from "@/lib/db";
import { queueOp } from "@/lib/sync-engine";
import { useAppSession } from "@/lib/use-app-session";
import { useTranslation } from "@/lib/use-translation";
import { formatElapsed, computeGunTimeOffsetSeconds } from "@/lib/timing";
import CameraScanner from "@/components/CameraScanner";
import NFCScanner, { type NFCReading } from "@/components/NFCScanner";
import Spinner from "@/components/Spinner";
import HighContrastToggle from "@/components/HighContrastToggle";
import { useHighContrast } from "@/lib/use-high-contrast";
import { HIGH_CONTRAST_VARS } from "@/lib/scan-high-contrast";

// Spec item 3 — "last 5 recorded times in a clean feed".
const RECENT_FEED_LIMIT = 5;

// Session 12's timing scanner — one device per timing point on the course.
// Deliberately always-optimistic (unlike the wallet charge terminal, which
// waits for the server's real answer): a live timing mat can't ask a
// runner to pause while a network round-trip resolves, and losing a tap
// entirely would be far worse than briefly showing a placeholder name. The
// server's authoritative gunTimeOffsetSeconds/splitTimeSeconds/athlete name
// land once the outbox syncs (see applyRecordChipTimeResult).
export default function TimingScannerPage() {
  const { eventId: rawEventId } = useParams<{ eventId: string }>();
  const eventId = decodeURIComponent(rawEventId);
  const router = useRouter();
  const { user, status } = useAppSession();
  const { t } = useTranslation();

  useEffect(() => {
    if (status !== "loading" && !user) router.push(`/login?callbackUrl=/scan/${eventId}/timing`);
  }, [status, user, router, eventId]);

  const event = useLiveQuery(async () => {
    const byId = await db.events.get(eventId);
    return byId ?? (await db.events.where("clientId").equals(eventId).first()) ?? null;
  }, [eventId]);

  const timingPoints = useLiveQuery(async () => {
    if (!event) return [];
    return db.timingPoints.where("eventId").equals(event.id).sortBy("sequenceOrder");
  }, [event?.id]);

  const [timingPointId, setTimingPointId] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { highContrast, toggle: toggleHighContrast } = useHighContrast();

  useEffect(() => {
    if (!timingPointId && timingPoints && timingPoints.length > 0) {
      setTimingPointId(timingPoints[0].id);
    }
  }, [timingPoints, timingPointId]);

  const recent = useLiveQuery(async () => {
    if (!timingPointId) return [];
    const all = await db.chipTimes.where("timingPointId").equals(timingPointId).toArray();
    return all.sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1)).slice(0, RECENT_FEED_LIMIT);
  }, [timingPointId]);
  const lastRecorded = recent?.[0] ?? null;

  // Refs so the scan handlers' identity stays stable — CameraScanner
  // restarts its stream whenever onDetect changes, same reasoning the gate
  // scanner's own ref-stabilization uses.
  const eventRef = useRef(event);
  eventRef.current = event;
  const timingPointRef = useRef(timingPointId);
  timingPointRef.current = timingPointId;
  const timingPointsRef = useRef(timingPoints);
  timingPointsRef.current = timingPoints;

  const recordTap = useCallback(async (input: { nfcUid?: string; ticketCode?: string }) => {
    const event = eventRef.current;
    const tpId = timingPointRef.current;
    const point = (timingPointsRef.current ?? []).find((p) => p.id === tpId);
    if (!event || !point) {
      setError(t("timing.selectPointFirst"));
      return;
    }
    setError(null);

    const clientId = newLocalId();
    const recordedAt = new Date();
    const gunTimeOffsetSeconds = computeGunTimeOffsetSeconds(
      event.gunStartAt ? new Date(event.gunStartAt) : null,
      recordedAt
    );

    // Optimistic placeholder — the real athlete name/bib/split arrive once
    // this syncs. bib shows the scanned uid's own last 4 when available
    // (the same value the server will end up storing), or the raw ticket
    // code as an interim identifier for a QR scan.
    const optimistic: LocalChipTime = {
      id: clientId,
      clientId,
      eventId: event.id,
      timingPointId: point.id,
      timingPointName: point.name,
      credentialId: "",
      athleteName: t("common.recordingPlaceholder"),
      bib: input.nfcUid ? input.nfcUid.slice(-4).toUpperCase() : input.ticketCode ?? "",
      ticketTypeName: "",
      recordedAt: recordedAt.toISOString(),
      gunTimeOffsetSeconds,
      splitTimeSeconds: null,
      syncStatus: "pending",
    };
    await db.chipTimes.put(optimistic);

    await queueOp("RECORD_CHIP_TIME", {
      clientId,
      eventId: event.id,
      eventClientId: event.clientId,
      timingPointId: point.id,
      timingPointClientId: point.clientId,
      nfcUid: input.nfcUid,
      ticketCode: input.ticketCode,
      recordedAt: recordedAt.toISOString(),
    });
  }, [t]);

  const handleNfcDetect = useCallback((reading: NFCReading) => {
    if (reading.uid) recordTap({ nfcUid: reading.uid });
  }, [recordTap]);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    recordTap({ ticketCode: code.trim().toUpperCase() });
    setCode("");
    inputRef.current?.focus();
  }

  if (!user) return null;

  if (event === undefined) {
    return (
      <div className="mx-auto flex max-w-lg flex-col items-center gap-3 px-4 py-16 text-center text-muted">
        <Spinner />
        <span>{t("common.loading")}</span>
      </div>
    );
  }
  if (!event) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <p className="font-semibold">{t("common.eventNotFound")}</p>
        <Link href="/dashboard" className="btn-secondary mt-6 inline-flex">{t("common.backToDashboard")}</Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background" style={highContrast ? HIGH_CONTRAST_VARS : undefined}>
    <div className="mx-auto max-w-lg px-4 pb-20 pt-8 sm:px-6">
      <Link href={`/dashboard/events/${event.id}`} className="text-sm text-muted hover:text-foreground">
        ← {event.title}
      </Link>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{t("timing.title")}</h1>
        <HighContrastToggle highContrast={highContrast} onToggle={toggleHighContrast} />
      </div>
      {event.gunStartAt && (
        <p className="mt-1 text-sm text-muted">
          {t("timing.gunTimeLabel")} <span className="font-mono">{formatElapsed((Date.now() - new Date(event.gunStartAt).getTime()) / 1000)}</span>
        </p>
      )}

      <div className="card mt-4 p-5">
        <label className="label" htmlFor="timingPoint">{t("timing.selectPointLabel")}</label>
        <select id="timingPoint" className="input min-h-12 text-base" value={timingPointId} onChange={(e) => setTimingPointId(e.target.value)}>
          {(timingPoints ?? []).length === 0 && <option value="">{t("timing.noPointsSetUp")}</option>}
          {(timingPoints ?? []).map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}

      <div className="mt-4">
        <CameraScanner onDetect={(scanned) => recordTap({ ticketCode: scanned.trim().toUpperCase() })} />
        <NFCScanner onDetect={handleNfcDetect} />
      </div>

      <form onSubmit={onSubmit} className="flex gap-2">
        <input
          ref={inputRef}
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={t("timing.enterCodeManually")}
          className="input min-h-12 font-mono text-base uppercase tracking-widest"
        />
        <button type="submit" className="btn-primary min-h-12 shrink-0 text-base">{t("timing.record")}</button>
      </form>

      {/* Spec item 3 — the just-recorded time in large, instantly-readable
          type, athlete/bib prominent above it. Separate from the feed
          below (which still lists it as its top row) so there's always one
          unmissable answer to "did that just work". */}
      {lastRecorded && (
        <div className="card mt-6 p-6 text-center">
          <p className="text-lg font-bold">{lastRecorded.athleteName}</p>
          <p className="mt-0.5 text-base text-muted">
            {t("timing.bibLabel", { bib: lastRecorded.bib })}
            {lastRecorded.ticketTypeName ? ` · ${lastRecorded.ticketTypeName}` : ""}
          </p>
          <p className="mt-2 font-mono text-[clamp(2.5rem,14vw,4.5rem)] font-extrabold leading-none tabular-nums">
            {lastRecorded.gunTimeOffsetSeconds != null ? formatElapsed(lastRecorded.gunTimeOffsetSeconds) : "—"}
          </p>
          {lastRecorded.syncStatus === "pending" && (
            <span className="pill mt-2 border-warn/40 bg-warn/10 text-warn">{t("common.pendingSync")}</span>
          )}
        </div>
      )}

      <h2 className="mb-3 mt-8 text-lg font-semibold">{t("timing.lastRecorded")}</h2>
      {(recent ?? []).length === 0 ? (
        <div className="card p-6 text-center text-muted">{t("timing.nothingRecorded")}</div>
      ) : (
        <div className="card divide-y divide-border">
          {(recent ?? []).map((c) => (
            <div key={c.id} className="flex items-center justify-between p-4">
              <div>
                <p className="text-base font-semibold">{c.athleteName}</p>
                <p className="text-sm text-muted">{t("timing.bibLabel", { bib: c.bib })}{c.ticketTypeName ? ` · ${c.ticketTypeName}` : ""}</p>
              </div>
              <div className="text-right">
                <p className="font-mono text-xl font-bold tabular-nums">{c.gunTimeOffsetSeconds != null ? formatElapsed(c.gunTimeOffsetSeconds) : "—"}</p>
                {c.syncStatus === "pending" && <span className="pill border-warn/40 bg-warn/10 text-warn">{t("common.pendingSync")}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
    </div>
  );
}
