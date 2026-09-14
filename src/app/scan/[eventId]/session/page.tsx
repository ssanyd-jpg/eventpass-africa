"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { db, newLocalId, type LocalSessionAttendance } from "@/lib/db";
import { queueOp } from "@/lib/sync-engine";
import { useAppSession } from "@/lib/use-app-session";
import { useTranslation } from "@/lib/use-translation";
import { formatDateTime } from "@/lib/format";
import CameraScanner from "@/components/CameraScanner";
import NFCScanner, { type NFCReading } from "@/components/NFCScanner";

// Session 19's conference session-attendance scanner — one device per
// room/door, same shape as the Session 12 timing scanner it's modeled on
// (src/app/scan/[eventId]/timing/page.tsx). Deliberately always-optimistic
// for the same reason: a room door can't ask an attendee to pause while a
// network round trip resolves. The room's live count comes from
// db.conferenceSessions' server-computed attendanceCount (refreshed every
// pull, see payload.myConferenceSessions), not from this device's own local
// tap history — multiple devices may share one door.
export default function SessionAttendanceScannerPage() {
  const { eventId: rawEventId } = useParams<{ eventId: string }>();
  const eventId = decodeURIComponent(rawEventId);
  const router = useRouter();
  const { user, status } = useAppSession();
  const { t } = useTranslation();

  useEffect(() => {
    if (status !== "loading" && !user) router.push(`/login?callbackUrl=/scan/${eventId}/session`);
  }, [status, user, router, eventId]);

  const event = useLiveQuery(async () => {
    const byId = await db.events.get(eventId);
    return byId ?? (await db.events.where("clientId").equals(eventId).first()) ?? null;
  }, [eventId]);

  const sessions = useLiveQuery(async () => {
    if (!event) return [];
    return db.conferenceSessions.where("eventId").equals(event.id).sortBy("startsAt");
  }, [event?.id]);

  const [eventSessionId, setEventSessionId] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!eventSessionId && sessions && sessions.length > 0) {
      setEventSessionId(sessions[0].id);
    }
  }, [sessions, eventSessionId]);

  const activeSession = (sessions ?? []).find((s) => s.id === eventSessionId);

  const recent = useLiveQuery(async () => {
    if (!eventSessionId) return [];
    const all = await db.sessionAttendances.where("eventSessionId").equals(eventSessionId).toArray();
    return all.sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1)).slice(0, 10);
  }, [eventSessionId]);

  // Refs so the scan handlers' identity stays stable — CameraScanner
  // restarts its stream whenever onDetect changes, same reasoning the
  // timing/gate scanners' own ref-stabilization uses.
  const eventRef = useRef(event);
  eventRef.current = event;
  const sessionIdRef = useRef(eventSessionId);
  sessionIdRef.current = eventSessionId;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const recordTap = useCallback(async (input: { nfcUid?: string; ticketCode?: string }) => {
    const event = eventRef.current;
    const sessId = sessionIdRef.current;
    const eventSession = (sessionsRef.current ?? []).find((s) => s.id === sessId);
    if (!event || !eventSession) {
      setError(t("session.selectSessionFirst"));
      return;
    }
    setError(null);

    const clientId = newLocalId();
    const recordedAt = new Date();

    // Optimistic placeholder — the real attendee name/ticket type arrive
    // once this syncs, same discipline as the timing scanner's own
    // optimistic LocalChipTime row.
    const optimistic: LocalSessionAttendance = {
      id: clientId,
      clientId,
      eventId: event.id,
      eventSessionId: eventSession.id,
      eventSessionName: eventSession.name,
      credentialId: "",
      attendeeName: t("common.recordingPlaceholder"),
      ticketTypeName: "",
      recordedAt: recordedAt.toISOString(),
      syncStatus: "pending",
    };
    await db.sessionAttendances.put(optimistic);

    await queueOp("RECORD_SESSION_ATTENDANCE", {
      clientId,
      eventId: event.id,
      eventClientId: event.clientId,
      eventSessionId: eventSession.id,
      eventSessionClientId: eventSession.clientId,
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
    return <div className="mx-auto max-w-lg px-4 py-16 text-center text-muted">{t("common.loading")}</div>;
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
    <div className="mx-auto max-w-lg px-4 pb-20 pt-8 sm:px-6">
      <Link href={`/dashboard/events/${event.id}`} className="text-sm text-muted hover:text-foreground">
        ← {event.title}
      </Link>
      <h1 className="mt-3 text-2xl font-bold">{t("session.title")}</h1>

      <div className="card mt-4 p-5">
        <label className="label" htmlFor="session">{t("session.selectSessionLabel")}</label>
        <select id="session" className="input" value={eventSessionId} onChange={(e) => setEventSessionId(e.target.value)}>
          {(sessions ?? []).length === 0 && <option value="">{t("session.noSessionsSetUp")}</option>}
          {(sessions ?? []).map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        {activeSession && (
          <p className="mt-3 rounded-xl border border-ok/40 bg-ok/10 p-4 text-center">
            <span className="block text-xs uppercase tracking-wide text-muted">{t("session.attendeesInRoom")}</span>
            <span className="mt-1 block text-2xl font-bold tabular-nums">{activeSession.attendanceCount}</span>
          </p>
        )}
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
          placeholder={t("session.enterCodeManually")}
          className="input font-mono uppercase tracking-widest"
        />
        <button type="submit" className="btn-primary shrink-0">{t("session.record")}</button>
      </form>

      <h2 className="mb-3 mt-8 font-semibold">{t("session.lastRecorded")}</h2>
      {(recent ?? []).length === 0 ? (
        <div className="card p-6 text-center text-muted">{t("session.nothingRecorded")}</div>
      ) : (
        <div className="card divide-y divide-border">
          {(recent ?? []).map((a) => (
            <div key={a.id} className="flex items-center justify-between p-3 text-sm">
              <div>
                <p className="font-medium">{a.attendeeName}</p>
                <p className="text-xs text-muted">{a.ticketTypeName || "—"} · {formatDateTime(a.recordedAt)}</p>
              </div>
              {a.syncStatus === "pending" && <span className="pill border-warn/40 bg-warn/10 text-warn">{t("common.pendingSync")}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
