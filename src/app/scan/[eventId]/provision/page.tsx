"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { db, newLocalId, type LocalCredential, type LocalWallet } from "@/lib/db";
import { queueOp, useOnlineStatus } from "@/lib/sync-engine";
import { useAppSession } from "@/lib/use-app-session";
import { useTranslation } from "@/lib/use-translation";
import { formatCents, generateTicketCode } from "@/lib/format";
import NFCScanner, { type NFCReading } from "@/components/NFCScanner";
import CameraScanner from "@/components/CameraScanner";
import { findAttendeeCandidates } from "./actions";

type Candidate = { id: string; name: string; email: string };
type FoundTicket = { id: string; code: string } | null;
type Confirmation = {
  attendeeLabel: string;
  walletCode: string;
  balanceCents: number;
  currency: string;
  ticket: FoundTicket;
  queuedOffline: boolean;
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
  const [manualUid, setManualUid] = useState("");
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  // Only ever set from the offline local ticket-code search or the
  // ticket-QR camera scan — see runProvision's comment on why an
  // online name/email match can't carry a known ticket id/code client-side.
  const [foundTicket, setFoundTicket] = useState<FoundTicket>(null);
  const [searching, setSearching] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleTagRead = useCallback((reading: NFCReading) => {
    if (!reading.uid) {
      setError(t("provision.noUidError"));
      return;
    }
    setError(null);
    setScannedUid(reading.uid);
  }, [t]);

  function useManualUid() {
    const trimmed = manualUid.trim();
    if (!trimmed) return;
    setError(null);
    setScannedUid(trimmed);
  }

  const runSearch = useCallback(async (trimmed: string) => {
    if (!event) return;
    if (!trimmed) {
      setCandidates(null);
      setFoundTicket(null);
      return;
    }
    setSearching(true);
    setFoundTicket(null);
    try {
      if (online) {
        const found = await findAttendeeCandidates(event.id, trimmed);
        setCandidates(found);
      } else {
        // Offline fallback: search already-synced local orders for a
        // matching ticket code only — no name/email is stored locally
        // (see LocalOrder's deliberate PII-scoping), so a match is labeled
        // by ticket type + code rather than a real name.
        const orders = await db.orders.where("eventId").equals(event.id).toArray();
        let match: Candidate | null = null;
        for (const order of orders) {
          const ticket = order.tickets.find((tk) => tk.code.toLowerCase() === trimmed.toLowerCase());
          if (ticket) {
            match = { id: order.userId, name: `${ticket.ticketTypeName} — ${ticket.code}`, email: "" };
            setFoundTicket({ id: ticket.id, code: ticket.code });
            break;
          }
        }
        setCandidates(match ? [match] : []);
      }
    } catch {
      setError("Couldn't search right now.");
    } finally {
      setSearching(false);
    }
  }, [event, online]);

  useEffect(() => {
    if (!scannedUid || !event) return;
    const handle = setTimeout(() => runSearch(query.trim()), 300);
    return () => clearTimeout(handle);
  }, [query, scannedUid, event, runSearch]);

  async function runProvision(attendee: Candidate | { email: string; name: string }) {
    if (!scannedUid || !event || !user) return;
    setBusy(true);
    setError(null);
    try {
      const clientId = newLocalId();
      const isExistingUser = "id" in attendee;
      const userId = isExistingUser ? attendee.id : undefined;

      // Find (or optimistically create) this attendee's wallet for this
      // event, matching registerWallet()'s own optimistic-write shape
      // exactly — this is the same "write local first, queue the op,
      // reconcile once synced" pattern every other mutation here uses.
      let wallet: LocalWallet | undefined = userId
        ? await db.wallets.where("ownerUserId").equals(userId).filter((w) => w.eventId === event.id).first()
        : undefined;
      let walletClientId: string | undefined;
      if (!wallet) {
        walletClientId = newLocalId();
        wallet = {
          id: walletClientId,
          clientId: walletClientId,
          code: generateTicketCode(),
          eventId: event.id,
          eventClientId: event.clientId ?? null,
          ownerUserId: userId ?? clientId, // placeholder until the server resolves/creates the real user
          ownerName: attendee.name,
          ownerEmail: attendee.email || null,
          balanceCents: 0,
          currency: event.currency,
          carryOverSourceWalletId: null,
          carryOverredAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          syncStatus: "pending",
        };
        await db.wallets.put(wallet);
      }

      // Optimistic Credential rows, keyed off this op's own clientId so
      // applyProvisionCredentialResult can find and replace them precisely
      // once the real server rows land.
      const credentials: LocalCredential[] = [
        {
          id: `${clientId}-wallet`,
          nfcUid: scannedUid,
          status: "ACTIVE",
          ticketId: null,
          walletId: wallet.id,
          code: wallet.code,
        },
      ];
      if (foundTicket) {
        credentials.push({
          id: `${clientId}-ticket`,
          nfcUid: scannedUid,
          status: "ACTIVE",
          ticketId: foundTicket.id,
          walletId: null,
          code: foundTicket.code,
        });
      }
      await db.credentials.bulkPut(credentials);

      await queueOp("PROVISION_CREDENTIAL", {
        clientId,
        eventId: event.id,
        eventClientId: event.clientId ?? null,
        nfcUid: scannedUid,
        walletClientId,
        ...(isExistingUser ? { userId: attendee.id } : { email: attendee.email, name: attendee.name }),
      });

      setConfirmation({
        attendeeLabel: attendee.name,
        walletCode: wallet.code,
        balanceCents: wallet.balanceCents,
        currency: wallet.currency,
        ticket: foundTicket,
        queuedOffline: !online,
      });
    } catch {
      setError("Couldn't provision this wristband — try again.");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setScannedUid(null);
    setManualUid("");
    setQuery("");
    setCandidates(null);
    setFoundTicket(null);
    setNewName("");
    setNewEmail("");
    setError(null);
    setConfirmation(null);
  }

  // Immediately ready for the next attendee — auto-resets 3s after a
  // successful provision.
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

  const maskedWalletCode = confirmation
    ? `••••${confirmation.walletCode.replace(/-/g, "").slice(-4)}`
    : "";
  const uidLast4 = scannedUid ? scannedUid.replace(/[^a-zA-Z0-9]/g, "").slice(-4).toUpperCase() : "";

  return (
    <div className="mx-auto max-w-lg px-4 pb-20 pt-8 sm:px-6">
      <Link href={`/dashboard/events/${event.id}`} className="text-sm text-muted hover:text-foreground">
        ← {event.title}
      </Link>

      <h1 className="mt-3 text-2xl font-bold">{t("provision.title")}</h1>

      {confirmation ? (
        <div className="card mt-5 p-5">
          <p className="font-semibold text-ok">{t("provision.success")}</p>
          {confirmation.queuedOffline && (
            <p className="mt-1 text-sm text-warn">{t("provision.queuedOffline")}</p>
          )}
          <p className="mt-1 text-sm text-muted">{confirmation.attendeeLabel}</p>
          <div className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted">{t("provision.walletCode")}</span>
              <span className="font-mono">{maskedWalletCode}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">{t("provision.uidLast4")}</span>
              <span className="font-mono">•• {uidLast4}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">{t("provision.balance")}</span>
              <span className="font-mono">{formatCents(confirmation.balanceCents, confirmation.currency)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">{t("provision.ticketCode")}</span>
              <span className="font-mono">
                {confirmation.ticket
                  ? confirmation.ticket.code
                  : confirmation.queuedOffline
                    ? t("provision.noTicket")
                    : t("provision.ticketPending")}
              </span>
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

          <div className="mt-4 border-t border-border pt-4">
            <label className="label" htmlFor="manualUid">{t("provision.manualUidLabel")}</label>
            <div className="mt-1 flex gap-2">
              <input
                id="manualUid"
                className="input flex-1"
                placeholder={t("provision.manualUidPlaceholder")}
                value={manualUid}
                onChange={(e) => setManualUid(e.target.value)}
              />
              <button type="button" className="btn-secondary" disabled={!manualUid.trim()} onClick={useManualUid}>
                {t("provision.useUid")}
              </button>
            </div>
          </div>

          {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        </div>
      ) : (
        <div className="mt-5">
          {!online && <p className="mb-3 text-sm text-warn">{t("provision.offlineSearchNote")}</p>}
          <label className="label" htmlFor="attendeeQuery">{t("provision.searchLabel")}</label>
          <input
            id="attendeeQuery"
            autoFocus
            className="input"
            placeholder={t("provision.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          <div className="mt-2">
            <CameraScanner onDetect={(code) => { setQuery(code); runSearch(code); }} />
            <p className="-mt-2 text-xs text-muted">{t("provision.scanTicketQr")}</p>
          </div>

          {searching && <p className="mt-2 text-sm text-muted">…</p>}

          {candidates && candidates.length > 0 && (
            <div className="card mt-3 divide-y divide-border">
              {candidates.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  disabled={busy}
                  className="flex w-full items-center justify-between p-3 text-left text-sm hover:bg-surface2 disabled:opacity-50"
                  onClick={() => runProvision(c)}
                >
                  <span>{c.name}</span>
                  <span className="text-muted">{c.email}</span>
                </button>
              ))}
            </div>
          )}

          {candidates && candidates.length === 0 && !online && (
            <p className="mt-4 text-sm text-muted">{t("provision.offlineNoResults")}</p>
          )}

          {candidates && candidates.length === 0 && online && (
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
