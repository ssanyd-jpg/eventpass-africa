"use client";

import { useCallback, useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { db, newLocalId } from "@/lib/db";
import { useOnlineStatus } from "@/lib/sync-engine";
import { useAppSession } from "@/lib/use-app-session";
import { useTranslation } from "@/lib/use-translation";
import NFCScanner, { type NFCReading } from "@/components/NFCScanner";
import { findAttendeeCandidates, provisionWristband } from "./actions";

type Candidate = { id: string; name: string; email: string };
type ProvisionResult = {
  user: Candidate;
  wallet: { id: string; code: string };
  ticket: { id: string; code: string } | null;
};

export default function ProvisionPage() {
  const { eventId: rawEventId } = useParams<{ eventId: string }>();
  const eventId = decodeURIComponent(rawEventId);
  const router = useRouter();
  const { user, status } = useAppSession();
  const online = useOnlineStatus();
  const { t } = useTranslation();

  // Middleware already redirects GATE_CREW away from this route server-side
  // — this covers the baseline "must be signed in" case and the offline-
  // cached-shell case, same as every other scan page.
  useEffect(() => {
    if (status !== "loading" && !user) router.push(`/login?callbackUrl=/scan/${eventId}/provision`);
    if (user?.organizationRole === "GATE_CREW") router.replace("/dashboard");
  }, [status, user, router, eventId]);

  const event = useLiveQuery(async () => {
    const byId = await db.events.get(eventId);
    if (byId) return byId;
    return (await db.events.where("clientId").equals(eventId).first()) ?? null;
  }, [eventId]);

  const [scannedUid, setScannedUid] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProvisionResult | null>(null);

  const handleTagRead = useCallback((reading: NFCReading) => {
    if (!reading.uid) {
      setError(t("provision.noUidError"));
      return;
    }
    setError(null);
    setScannedUid(reading.uid);
  }, [t]);

  useEffect(() => {
    if (!scannedUid || !event) return;
    const handle = setTimeout(async () => {
      const trimmed = query.trim();
      if (!trimmed) {
        setCandidates(null);
        return;
      }
      setSearching(true);
      try {
        const found = await findAttendeeCandidates(event.id, trimmed);
        setCandidates(found);
      } catch {
        setError("Couldn't search right now.");
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [query, scannedUid, event]);

  async function runProvision(attendee: { userId: string } | { email: string; name: string }) {
    if (!scannedUid || !event) return;
    if (!online) {
      setError(t("provision.offlineError"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const provisioned = await provisionWristband(event.id, scannedUid, attendee);
      // Opportunistically reflect the new link locally so THIS device can
      // resolve the tag immediately, without waiting for the next pull —
      // the next pull will replace this with the server-authoritative rows.
      await db.credentials.bulkPut([
        {
          id: newLocalId(),
          nfcUid: scannedUid,
          status: "ACTIVE",
          ticketId: null,
          walletId: provisioned.wallet.id,
          code: provisioned.wallet.code,
        },
        ...(provisioned.ticket
          ? [
              {
                id: newLocalId(),
                nfcUid: scannedUid,
                status: "ACTIVE",
                ticketId: provisioned.ticket.id,
                walletId: null,
                code: provisioned.ticket.code,
              },
            ]
          : []),
      ]);
      setResult(provisioned);
    } catch {
      setError("Couldn't provision this wristband — try again.");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setScannedUid(null);
    setQuery("");
    setCandidates(null);
    setNewName("");
    setNewEmail("");
    setError(null);
    setResult(null);
  }

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

  return (
    <div className="mx-auto max-w-lg px-4 pb-20 pt-8 sm:px-6">
      <Link href={`/dashboard/events/${event.id}`} className="text-sm text-muted hover:text-foreground">
        ← {event.title}
      </Link>

      <h1 className="mt-3 text-2xl font-bold">{t("provision.title")}</h1>

      {result ? (
        <div className="card mt-5 p-5">
          <p className="font-semibold text-ok">{t("provision.success")}</p>
          <p className="mt-1 text-sm text-muted">{result.user.name} ({result.user.email})</p>
          <div className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted">{t("provision.walletCode")}</span>
              <span className="font-mono">{result.wallet.code}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">{t("provision.ticketCode")}</span>
              <span className="font-mono">{result.ticket ? result.ticket.code : t("provision.noTicket")}</span>
            </div>
          </div>
          <button type="button" className="btn-primary mt-5 w-full" onClick={reset}>
            {t("provision.another")}
          </button>
        </div>
      ) : !scannedUid ? (
        <div className="mt-5">
          <p className="mb-3 text-sm text-muted">{t("provision.scanPrompt")}</p>
          <NFCScanner onDetect={handleTagRead} />
          {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        </div>
      ) : (
        <div className="mt-5">
          {!online && <p className="mb-3 text-sm text-warn">{t("provision.offlineError")}</p>}
          <label className="label" htmlFor="attendeeQuery">{t("provision.searchLabel")}</label>
          <input
            id="attendeeQuery"
            autoFocus
            className="input"
            placeholder={t("provision.searchPlaceholder")}
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
                  disabled={busy}
                  className="flex w-full items-center justify-between p-3 text-left text-sm hover:bg-surface2 disabled:opacity-50"
                  onClick={() => runProvision({ userId: c.id })}
                >
                  <span>{c.name}</span>
                  <span className="text-muted">{c.email}</span>
                </button>
              ))}
            </div>
          )}

          {candidates && candidates.length === 0 && (
            <div className="mt-4 border-t border-border pt-4">
              <p className="mb-2 text-sm text-muted">{t("provision.noResults")}</p>
              <p className="label">{t("provision.createNew")}</p>
              <div className="mt-2 space-y-2">
                <input
                  className="input"
                  placeholder={t("provision.nameLabel")}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
                <input
                  className="input"
                  type="email"
                  placeholder={t("provision.emailLabel")}
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                />
                <button
                  type="button"
                  disabled={busy || !newName.trim() || !newEmail.trim()}
                  className="btn-primary w-full disabled:opacity-50"
                  onClick={() => runProvision({ name: newName.trim(), email: newEmail.trim() })}
                >
                  {busy ? "…" : t("provision.confirmButton")}
                </button>
              </div>
            </div>
          )}

          {error && <p className="mt-3 text-sm text-danger">{error}</p>}
        </div>
      )}
    </div>
  );
}
