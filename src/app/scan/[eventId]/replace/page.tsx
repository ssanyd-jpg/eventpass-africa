"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { db, newLocalId, type LocalCredential, type LocalWallet } from "@/lib/db";
import { queueOp, useOnlineStatus } from "@/lib/sync-engine";
import { useAppSession } from "@/lib/use-app-session";
import { useTranslation } from "@/lib/use-translation";
import type { TranslationKey } from "@/lib/i18n";
import { formatCents } from "@/lib/format";
import NFCScanner, { type NFCReading } from "@/components/NFCScanner";
import { findAttendeeCandidates } from "../provision/actions";
import type { AttendeeCandidate } from "@/lib/wristband-handlers";

type Candidate = { id: string; name: string; email: string };
// Session 13: findAttendeeCandidates can also return a group-member ticket
// match with no attendee account at all (see AttendeeCandidate's
// "groupMember" variant). Replacing a group member's own wristband isn't
// part of this flow yet, so those matches are excluded before they ever
// reach this page's own (unrelated, pre-Session-13) Candidate shape.
function isUserCandidate(c: AttendeeCandidate): c is Extract<AttendeeCandidate, { kind: "user" }> {
  return c.kind === "user";
}
type Reason = "LOST" | "DAMAGED" | "STOLEN";
const REASON_LABEL_KEY: Record<Reason, TranslationKey> = {
  LOST: "replace.reasonLost",
  DAMAGED: "replace.reasonDamaged",
  STOLEN: "replace.reasonStolen",
};
type Confirmation = {
  attendeeLabel: string;
  oldNfcUid: string;
  newNfcUid: string;
  balanceCents: number;
  currency: string;
  reason: Reason;
  queuedOffline: boolean;
};

function last4(uid: string) {
  return uid.replace(/[^a-zA-Z0-9]/g, "").slice(-4).toUpperCase();
}

export default function ReplaceWristbandPage() {
  const { eventId: rawEventId } = useParams<{ eventId: string }>();
  const eventId = decodeURIComponent(rawEventId);
  const router = useRouter();
  const { user, status } = useAppSession();
  const online = useOnlineStatus();
  const { t } = useTranslation();

  // Same OWNER/STAFF-not-GATE_CREW gate as the provisioning page — middleware
  // already redirects server-side; this covers "must be signed in" and the
  // offline-cached-shell case.
  useEffect(() => {
    if (status !== "loading" && !user) router.push(`/login?callbackUrl=/scan/${eventId}/replace`);
    if (user?.organizationRole === "GATE_CREW") router.replace("/dashboard");
  }, [status, user, router, eventId]);

  const event = useLiveQuery(async () => {
    const byId = await db.events.get(eventId);
    if (byId) return byId;
    return (await db.events.where("clientId").equals(eventId).first()) ?? null;
  }, [eventId]);

  const [manualUid, setManualUid] = useState("");
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [searching, setSearching] = useState(false);

  // The attendee's current, about-to-be-superseded wristband — found either
  // by scanning/entering its own uid directly, or by resolving a name/email
  // match to their wallet and then to whatever active credential rows share
  // its uid. Either path converges here before the reason/new-uid steps.
  const [oldNfcUid, setOldNfcUid] = useState<string | null>(null);
  const [oldCredentialRows, setOldCredentialRows] = useState<LocalCredential[] | null>(null);
  const [attendeeWallet, setAttendeeWallet] = useState<LocalWallet | null>(null);
  const [attendeeLabel, setAttendeeLabel] = useState("");

  const [reason, setReason] = useState<Reason | "">("");
  const [manualNewUid, setManualNewUid] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pure local Dexie lookup — works identically online or offline, since the
  // credentials/wallets tables are already synced. This is deliberately the
  // ONLY way to identify an attendee while offline (see the offline search
  // note in the render below): unlike provisioning's offline ticket-code
  // fallback, there is no PII-free local proxy for "search by name" here.
  const loadByUid = useCallback(async (uid: string, fallbackLabel?: string) => {
    const rows = await db.credentials.where("nfcUid").equals(uid).filter((r) => r.status === "ACTIVE").toArray();
    if (rows.length === 0) return false;
    const walletId = rows.find((r) => r.walletId)?.walletId;
    const wallet = walletId ? await db.wallets.get(walletId) : undefined;
    if (!wallet) return false;
    setOldNfcUid(uid);
    setOldCredentialRows(rows);
    setAttendeeWallet(wallet);
    setAttendeeLabel(fallbackLabel ?? wallet.ownerName ?? wallet.ownerEmail ?? "Attendee");
    setError(null);
    return true;
  }, []);

  const handleTagRead = useCallback(
    async (reading: NFCReading) => {
      if (!reading.uid) return;
      const found = await loadByUid(reading.uid);
      if (!found) setError(t("replace.uidNotFound"));
    },
    [loadByUid, t]
  );

  async function useManualUid() {
    const trimmed = manualUid.trim();
    if (!trimmed) return;
    const found = await loadByUid(trimmed);
    if (!found) setError(t("replace.uidNotFound"));
  }

  const runSearch = useCallback(
    async (trimmed: string) => {
      if (!event || !online) return;
      if (!trimmed) {
        setCandidates(null);
        return;
      }
      setSearching(true);
      try {
        const found = await findAttendeeCandidates(event.id, trimmed);
        setCandidates(found.filter(isUserCandidate));
      } catch {
        setError("Couldn't search right now.");
      } finally {
        setSearching(false);
      }
    },
    [event, online]
  );

  useEffect(() => {
    const handle = setTimeout(() => runSearch(query.trim()), 300);
    return () => clearTimeout(handle);
  }, [query, runSearch]);

  async function pickCandidate(candidate: Candidate) {
    if (!event) return;
    setError(null);
    const wallet = await db.wallets
      .where("ownerUserId")
      .equals(candidate.id)
      .filter((w) => w.eventId === event.id)
      .first();
    if (!wallet) {
      setError(t("replace.noWalletFound"));
      return;
    }
    const rows = await db.credentials.where("walletId").equals(wallet.id).filter((r) => r.status === "ACTIVE").toArray();
    if (rows.length === 0) {
      setError(t("replace.noActiveWristband"));
      return;
    }
    // Re-load by the discovered uid so we also pick up any sibling
    // ticket-linked row sharing it, not just the wallet-linked one found
    // above — same convergence loadByUid gives the direct-scan path.
    await loadByUid(rows[0].nfcUid, candidate.name);
  }

  // Refs so runReplace/newTagRead keep a stable identity — same discipline
  // the gate scanner and wallet terminal use for their own NFC/camera
  // handlers, since a scanner's onDetect closure can otherwise go stale
  // mid-session (it's captured once, when the user starts scanning, not
  // re-captured on every render).
  const oldNfcUidRef = useRef(oldNfcUid);
  oldNfcUidRef.current = oldNfcUid;
  const oldCredentialRowsRef = useRef(oldCredentialRows);
  oldCredentialRowsRef.current = oldCredentialRows;
  const attendeeWalletRef = useRef(attendeeWallet);
  attendeeWalletRef.current = attendeeWallet;
  const attendeeLabelRef = useRef(attendeeLabel);
  attendeeLabelRef.current = attendeeLabel;
  const reasonRef = useRef(reason);
  reasonRef.current = reason;
  const onlineRef = useRef(online);
  onlineRef.current = online;

  const runReplace = useCallback(async (newUid: string) => {
    const oldNfcUid = oldNfcUidRef.current;
    const oldCredentialRows = oldCredentialRowsRef.current;
    const attendeeWallet = attendeeWalletRef.current;
    const reason = reasonRef.current;
    if (!oldNfcUid || !oldCredentialRows || !attendeeWallet || !reason) return;
    setBusy(true);
    setError(null);
    try {
      const clientId = newLocalId();
      const now = new Date().toISOString();

      // Optimistic: flip the old local rows to SUPERSEDED in place — never
      // deleted, mirroring the server's own "preserve the audit trail"
      // discipline — and write new ACTIVE rows under the new uid, keyed off
      // this op's clientId so applyReplaceCredentialResult can find and
      // replace them precisely once the real server rows land.
      for (const row of oldCredentialRows) {
        await db.credentials.put({ ...row, status: "SUPERSEDED", supersededAt: now });
      }
      const newRows: LocalCredential[] = oldCredentialRows.map((row) => ({
        id: row.ticketId ? `${clientId}-ticket` : `${clientId}-wallet`,
        nfcUid: newUid,
        status: "ACTIVE",
        ticketId: row.ticketId,
        walletId: row.walletId,
        code: row.code,
        createdAt: now,
        supersededAt: null,
      }));
      await db.credentials.bulkPut(newRows);

      await queueOp("REPLACE_CREDENTIAL", { clientId, oldNfcUid, newNfcUid: newUid, reason });

      setConfirmation({
        attendeeLabel: attendeeLabelRef.current,
        oldNfcUid,
        newNfcUid: newUid,
        balanceCents: attendeeWallet.balanceCents,
        currency: attendeeWallet.currency,
        reason,
        queuedOffline: !onlineRef.current,
      });
    } catch {
      setError(t("replace.error"));
    } finally {
      setBusy(false);
    }
  }, [t]);

  const newTagRead = useCallback(
    async (reading: NFCReading) => {
      if (reading.uid) await runReplace(reading.uid);
    },
    [runReplace]
  );

  async function useManualNewUid() {
    const trimmed = manualNewUid.trim();
    if (!trimmed) return;
    await runReplace(trimmed);
  }

  function reset() {
    setManualUid("");
    setQuery("");
    setCandidates(null);
    setOldNfcUid(null);
    setOldCredentialRows(null);
    setAttendeeWallet(null);
    setAttendeeLabel("");
    setReason("");
    setManualNewUid("");
    setError(null);
    setConfirmation(null);
  }

  // Immediately ready for the next attendee — auto-resets 3s after a
  // successful replacement, matching the provisioning page's own UX.
  useEffect(() => {
    if (!confirmation) return;
    resetTimerRef.current = setTimeout(reset, 3000);
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmation]);

  if (!user) return null;
  if (user.organizationRole === "GATE_CREW") return null;

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

  const provisionedRow = oldCredentialRows?.[0];

  return (
    <div className="mx-auto max-w-lg px-4 pb-20 pt-8 sm:px-6">
      <Link href={`/dashboard/events/${event.id}`} className="text-sm text-muted hover:text-foreground">
        ← {event.title}
      </Link>

      <h1 className="mt-3 text-2xl font-bold">{t("replace.title")}</h1>

      {confirmation ? (
        <div className="card mt-5 p-5">
          <p className="font-semibold text-ok">{t("replace.success")}</p>
          {confirmation.queuedOffline && (
            <p className="mt-1 text-sm text-warn">{t("replace.queuedOffline")}</p>
          )}
          <p className="mt-1 text-sm text-muted">{confirmation.attendeeLabel}</p>
          <div className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted">{t("replace.oldUid")}</span>
              <span className="font-mono">•• {last4(confirmation.oldNfcUid)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">{t("replace.newUid")}</span>
              <span className="font-mono">•• {last4(confirmation.newNfcUid)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">{t("replace.balance")}</span>
              <span className="font-mono">{formatCents(confirmation.balanceCents, confirmation.currency)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">{t("replace.reasonLoggedPrefix")}</span>
              <span className="font-mono">{t(REASON_LABEL_KEY[confirmation.reason])}</span>
            </div>
          </div>
          <button type="button" className="btn-primary mt-5 w-full" onClick={reset}>
            {t("replace.another")}
          </button>
        </div>
      ) : !oldNfcUid ? (
        <div className="mt-5">
          <p className="mb-3 text-sm text-muted">{t("replace.scanOldPrompt")}</p>
          <NFCScanner onDetect={handleTagRead} />

          <div className="mt-4 border-t border-border pt-4">
            <label className="label" htmlFor="manualUid">{t("replace.manualUidLabel")}</label>
            <div className="mt-1 flex gap-2">
              <input
                id="manualUid"
                className="input flex-1"
                placeholder={t("replace.manualUidPlaceholder")}
                value={manualUid}
                onChange={(e) => setManualUid(e.target.value)}
              />
              <button type="button" className="btn-secondary" disabled={!manualUid.trim()} onClick={useManualUid}>
                {t("replace.useUid")}
              </button>
            </div>
          </div>

          <div className="mt-4 border-t border-border pt-4">
            {!online && <p className="mb-3 text-sm text-warn">{t("replace.offlineSearchNote")}</p>}
            {online && (
              <>
                <label className="label" htmlFor="attendeeQuery">{t("replace.searchLabel")}</label>
                <input
                  id="attendeeQuery"
                  className="input"
                  placeholder={t("replace.searchPlaceholder")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {searching && <p className="mt-2 text-sm text-muted">…</p>}
                {candidates && candidates.length > 0 && (
                  <div className="card mt-3 divide-y divide-border">
                    {candidates.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className="flex w-full items-center justify-between p-3 text-left text-sm hover:bg-surface2"
                        onClick={() => pickCandidate(c)}
                      >
                        <span>{c.name}</span>
                        <span className="text-muted">{c.email}</span>
                      </button>
                    ))}
                  </div>
                )}
                {candidates && candidates.length === 0 && (
                  <p className="mt-3 text-sm text-muted">{t("replace.noResults")}</p>
                )}
              </>
            )}
          </div>

          {error && <p className="mt-3 text-sm text-danger">{error}</p>}
        </div>
      ) : (
        <div className="mt-5">
          <div className="card p-5">
            <p className="label">{t("replace.currentWristband")}</p>
            <p className="mt-1 font-semibold">{attendeeLabel}</p>
            <div className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted">{t("replace.uidLast4")}</span>
                <span className="font-mono">•• {last4(oldNfcUid)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">{t("replace.balance")}</span>
                <span className="font-mono">
                  {attendeeWallet ? formatCents(attendeeWallet.balanceCents, attendeeWallet.currency) : "—"}
                </span>
              </div>
              {provisionedRow?.createdAt && (
                <div className="flex justify-between">
                  <span className="text-muted">{t("replace.provisionedDate")}</span>
                  <span className="font-mono">{new Date(provisionedRow.createdAt).toLocaleDateString()}</span>
                </div>
              )}
            </div>
          </div>

          <div className="mt-4">
            <p className="label">{t("replace.reasonLabel")}</p>
            <div className="mt-2 flex gap-2">
              {(["LOST", "DAMAGED", "STOLEN"] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  className={reason === r ? "btn-primary" : "btn-secondary"}
                  onClick={() => setReason(r)}
                >
                  {t(REASON_LABEL_KEY[r])}
                </button>
              ))}
            </div>
          </div>

          {reason && (
            <div className="mt-4 border-t border-border pt-4">
              <p className="mb-3 text-sm text-muted">{t("replace.newScanPrompt")}</p>
              <NFCScanner onDetect={newTagRead} />

              <div className="mt-4">
                <label className="label" htmlFor="manualNewUid">{t("replace.newManualUidLabel")}</label>
                <div className="mt-1 flex gap-2">
                  <input
                    id="manualNewUid"
                    className="input flex-1"
                    placeholder={t("replace.manualUidPlaceholder")}
                    value={manualNewUid}
                    onChange={(e) => setManualNewUid(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={busy || !manualNewUid.trim()}
                    onClick={useManualNewUid}
                  >
                    {busy ? "…" : t("replace.confirmButton")}
                  </button>
                </div>
              </div>
            </div>
          )}

          {error && <p className="mt-3 text-sm text-danger">{error}</p>}

          <button type="button" className="mt-4 text-xs font-medium text-muted hover:text-foreground" onClick={reset}>
            ← start over
          </button>
        </div>
      )}
    </div>
  );
}
