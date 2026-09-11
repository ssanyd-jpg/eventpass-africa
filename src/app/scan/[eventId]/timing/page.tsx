"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { db, newLocalId, type LocalChipTime } from "@/lib/db";
import { queueOp } from "@/lib/sync-engine";
import { useAppSession } from "@/lib/use-app-session";
import { formatElapsed, computeGunTimeOffsetSeconds } from "@/lib/timing";
import CameraScanner from "@/components/CameraScanner";
import NFCScanner, { type NFCReading } from "@/components/NFCScanner";

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

  useEffect(() => {
    if (!timingPointId && timingPoints && timingPoints.length > 0) {
      setTimingPointId(timingPoints[0].id);
    }
  }, [timingPoints, timingPointId]);

  const recent = useLiveQuery(async () => {
    if (!timingPointId) return [];
    const all = await db.chipTimes.where("timingPointId").equals(timingPointId).toArray();
    return all.sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1)).slice(0, 10);
  }, [timingPointId]);

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
      setError("Select a timing point first.");
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
      athleteName: "Recording…",
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
  }, []);

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
      <Link href={`/dashboard/events/${event.id}`} className="text-sm text-muted hover:text-foreground">
        ← {event.title}
      </Link>
      <h1 className="mt-3 text-2xl font-bold">Timing scanner</h1>
      {event.gunStartAt && (
        <p className="mt-1 text-sm text-muted">
          Gun time: <span className="font-mono">{formatElapsed((Date.now() - new Date(event.gunStartAt).getTime()) / 1000)}</span>
        </p>
      )}

      <div className="card mt-4 p-5">
        <label className="label" htmlFor="timingPoint">This device is at</label>
        <select id="timingPoint" className="input" value={timingPointId} onChange={(e) => setTimingPointId(e.target.value)}>
          {(timingPoints ?? []).length === 0 && <option value="">No timing points set up yet</option>}
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
          placeholder="Enter ticket code manually"
          className="input font-mono uppercase tracking-widest"
        />
        <button type="submit" className="btn-primary shrink-0">Record</button>
      </form>

      <h2 className="mb-3 mt-8 font-semibold">Last 10 recorded here</h2>
      {(recent ?? []).length === 0 ? (
        <div className="card p-6 text-center text-muted">Nothing recorded yet at this point.</div>
      ) : (
        <div className="card divide-y divide-border">
          {(recent ?? []).map((c) => (
            <div key={c.id} className="flex items-center justify-between p-3 text-sm">
              <div>
                <p className="font-medium">{c.athleteName}</p>
                <p className="text-xs text-muted">Bib {c.bib}{c.ticketTypeName ? ` · ${c.ticketTypeName}` : ""}</p>
              </div>
              <div className="text-right">
                <p className="font-mono">{c.gunTimeOffsetSeconds != null ? formatElapsed(c.gunTimeOffsetSeconds) : "—"}</p>
                {c.syncStatus === "pending" && <span className="pill border-warn/40 bg-warn/10 text-warn">Pending sync</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
