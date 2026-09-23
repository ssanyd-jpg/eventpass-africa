"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { db, newLocalId } from "@/lib/db";
import { queueOp } from "@/lib/sync-engine";
import { useOnlineStatus } from "@/lib/sync-engine";
import { useAppSession } from "@/lib/use-app-session";
import { useTranslation } from "@/lib/use-translation";
import CameraScanner from "@/components/CameraScanner";
import NFCScanner, { type NFCReading } from "@/components/NFCScanner";
import Spinner from "@/components/Spinner";
import ScanResultOverlay, { type ScanResultTone } from "@/components/ScanResultOverlay";
import HighContrastToggle from "@/components/HighContrastToggle";
import { useHighContrast } from "@/lib/use-high-contrast";
import { HIGH_CONTRAST_VARS } from "@/lib/scan-high-contrast";
import { resolveCodeFromUid, isUidSuperseded } from "@/lib/credentials";
import { resolveGateSignal } from "@/lib/ticket-types";

// Full-screen takeover for every result except "vip" (which keeps its own
// established gold screen) — maps this page's many result kinds down to
// the 3 visual tones the spec calls out (success/amber/red), auto-resets
// after 3s per spec item 1.
const RESULT_AUTO_RESET_MS = 3000;
function resultTone(kind: ScanResult["kind"]): ScanResultTone {
  if (kind === "valid") return "success";
  if (kind === "already" || kind === "paymentPending" || kind === "notProvisioned" || kind === "wristbandReplaced") return "warn";
  return "danger";
}
function resultIcon(tone: ScanResultTone): string {
  return tone === "success" ? "✓" : tone === "warn" ? "↻" : "✕";
}

type ScanResult = {
  kind:
    | "valid"
    | "vip"
    | "already"
    | "invalid"
    | "refunded"
    | "notApproved"
    | "paymentPending"
    | "paymentFailed"
    | "notProvisioned"
    | "wristbandReplaced";
  message: string;
  ticketTypeName?: string;
  boothNumber?: string | null;
  // Session 14 — the closest thing to an attendee name available offline
  // for a VIP screen: this device's local cache never carries a buyer's
  // real name (see LocalOrder's own comment on why), only a group member's
  // self-chosen label when this ticket was part of a Session 13 group
  // purchase. Absent for an ordinary solo VIP ticket.
  attendeeLabel?: string | null;
  code: string;
};

// Session 14 — how long the full-screen VIP confirmation stays up before
// auto-clearing, one second longer than the established 3s convention used
// elsewhere in this app (CameraScanner/NFCScanner's own re-scan debounce,
// the provisioning page's confirmation reset) so gate staff have time to
// register it and wave the attendee through before it disappears.
const VIP_AUTO_RESET_MS = 4000;

export default function GateScannerPage() {
  const { eventId: rawEventId } = useParams<{ eventId: string }>();
  const eventId = decodeURIComponent(rawEventId);
  const router = useRouter();
  const { user, status } = useAppSession();
  const online = useOnlineStatus();
  const { t } = useTranslation();

  // Previously this page had no auth check at all — anyone who guessed the
  // URL saw the full scanner. Real enforcement is server-side (per-org
  // checks in sync-handlers.ts); this just requires being signed in.
  useEffect(() => {
    if (status !== "loading" && !user) router.push(`/login?callbackUrl=/scan/${eventId}`);
  }, [status, user, router, eventId]);
  const [mode, setMode] = useState<"attendee" | "vendor">("attendee");
  const [code, setCode] = useState("");
  const [result, setResult] = useState<ScanResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { highContrast, toggle: toggleHighContrast } = useHighContrast();

  const event = useLiveQuery(async () => {
    const byId = await db.events.get(eventId);
    if (byId) return byId;
    return (await db.events.where("clientId").equals(eventId).first()) ?? null;
  }, [eventId]);

  const orders = useLiveQuery(async () => {
    if (!event) return [];
    return db.orders.where("eventId").equals(event.id).toArray();
  }, [event?.id]);

  // Allowlist, not an exclusion list — a ticket from a PENDING (awaiting
  // Airpay confirmation), PAYMENT_FAILED, or REFUNDED order must never scan
  // in, so only the two genuinely-checkoutable statuses count. NEEDS_REVIEW
  // stays allowed — pre-existing, unrelated oversell-review behavior.
  const tickets = useMemo(
    () =>
      (orders ?? [])
        .filter((o) => o.status === "PAID" || o.status === "NEEDS_REVIEW")
        .flatMap((o) => o.tickets.map((t) => ({ ...t, orderId: o.id }))),
    [orders]
  );
  // Codes that must be rejected at the gate with a specific reason — mirrors
  // the server-side handleCheckIn gate in sync-handlers.ts exactly, so the
  // offline scanner can't wave in a ticket the server would reject.
  const blockedCodes = useMemo(() => {
    const map = new Map<string, "refunded" | "paymentPending" | "paymentFailed">();
    for (const o of orders ?? []) {
      const kind = o.status === "REFUNDED" ? "refunded" : o.status === "PENDING" ? "paymentPending" : o.status === "PAYMENT_FAILED" ? "paymentFailed" : null;
      if (!kind) continue;
      for (const t of o.tickets) map.set(t.code, kind);
    }
    return map;
  }, [orders]);
  const checkedInCount = tickets.filter((t) => t.checkedIn).length;

  const vendors = useLiveQuery(async () => {
    if (!event) return [];
    return db.vendors.where("eventId").equals(event.id).toArray();
  }, [event?.id]);
  const approvedVendors = useMemo(() => (vendors ?? []).filter((v) => v.status === "APPROVED"), [vendors]);
  const vendorCheckedInCount = approvedVendors.filter((v) => v.checkedIn).length;

  // Refs so checkIn's identity stays stable across renders — CameraScanner
  // restarts its camera stream whenever its onDetect callback changes, which
  // would otherwise happen after every single scan (tickets/orders update).
  const eventRef = useRef(event);
  eventRef.current = event;
  const ticketsRef = useRef(tickets);
  ticketsRef.current = tickets;
  const blockedCodesRef = useRef(blockedCodes);
  blockedCodesRef.current = blockedCodes;
  const vendorsRef = useRef(vendors);
  vendorsRef.current = vendors;

  const checkIn = useCallback(async (rawCode: string) => {
    const normalized = rawCode.trim().toUpperCase();
    const event = eventRef.current;
    if (!normalized || !event) return;

    const blocked = blockedCodesRef.current.get(normalized);
    if (blocked) {
      const message =
        blocked === "refunded" ? t("scan.refunded")
        : blocked === "paymentPending" ? t("scan.paymentPending")
        : t("scan.paymentFailed");
      setResult({ kind: blocked, message, code: normalized });
      return;
    }

    const match = ticketsRef.current.find((tk) => tk.code === normalized);
    if (!match) {
      setResult({ kind: "invalid", message: t("scan.notFound"), code: normalized });
      return;
    }

    // Session 14 — decides valid/VIP/already in one place so "already
    // checked in" always wins even for a VIP ticket re-scanned a second
    // time; see resolveGateSignal's own comment for why.
    const signal = resolveGateSignal({
      checkedIn: match.checkedIn,
      ticketTypeName: match.ticketTypeName,
      isFastTrack: match.isFastTrack ?? false,
    });

    if (signal === "already") {
      setResult({
        kind: "already",
        message: t("scan.alreadyCheckedIn"),
        ticketTypeName: match.ticketTypeName,
        attendeeLabel: match.groupMemberName ?? null,
        code: normalized,
      });
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

    setResult(
      signal === "vip"
        ? {
            kind: "vip",
            message: t("scan.vipFastTrack"),
            ticketTypeName: match.ticketTypeName,
            attendeeLabel: match.groupMemberName ?? null,
            code: normalized,
          }
        : {
            kind: "valid",
            message: t("scan.entryGranted"),
            ticketTypeName: match.ticketTypeName,
            attendeeLabel: match.groupMemberName ?? null,
            code: normalized,
          }
    );
  }, [t]);

  // Session 14 — the VIP full-screen confirmation clears itself; every
  // other result kind is left exactly as before (persists until the next
  // scan overwrites it).
  useEffect(() => {
    if (result?.kind !== "vip") return;
    const timer = setTimeout(() => setResult(null), VIP_AUTO_RESET_MS);
    return () => clearTimeout(timer);
  }, [result]);

  const checkInVendor = useCallback(async (rawCode: string) => {
    const normalized = rawCode.trim().toUpperCase();
    const event = eventRef.current;
    if (!normalized || !event) return;

    const match = (vendorsRef.current ?? []).find((v) => v.badgeCode === normalized);
    if (!match) {
      setResult({ kind: "invalid", message: t("scan.vendorNotFound"), code: normalized });
      return;
    }
    if (match.status !== "APPROVED") {
      setResult({ kind: "notApproved", message: t("scan.vendorNotApproved"), code: normalized });
      return;
    }
    if (match.checkedIn) {
      setResult({
        kind: "already",
        message: t("scan.vendorAlreadyCheckedIn"),
        ticketTypeName: match.name,
        boothNumber: match.boothNumber,
        code: normalized,
      });
      return;
    }

    const scannedAt = new Date().toISOString();
    await db.vendors.put({ ...match, checkedIn: true, checkedInAt: scannedAt, syncStatus: "pending" });

    await queueOp("CHECK_IN_VENDOR", {
      clientId: newLocalId(),
      badgeCode: normalized,
      eventId: event.id,
      scannedAt,
    });

    setResult({
      kind: "valid",
      message: t("scan.vendorEntryGranted"),
      ticketTypeName: match.name,
      boothNumber: match.boothNumber,
      code: normalized,
    });
  }, [t]);

  const activeCheckIn = mode === "attendee" ? checkIn : checkInVendor;

  // NFC uid resolution first (a wristband provisioned via /scan/[eventId]/
  // provision), falling back to the decoded NDEF text for backward
  // compatibility — checkIn itself is untouched, it still just takes a
  // ticket code string. Attendee mode only: vendor badges have no
  // Credential-linking in this feature.
  const handleNfcDetect = useCallback(
    async (reading: NFCReading) => {
      const code = (reading.uid ? await resolveCodeFromUid(reading.uid, "ticket") : null) ?? reading.text;
      if (code) {
        checkIn(code);
        return;
      }
      if (reading.uid) {
        const replaced = await isUidSuperseded(reading.uid, "ticket");
        setResult({
          kind: replaced ? "wristbandReplaced" : "notProvisioned",
          message: replaced ? t("scan.wristbandReplaced") : t("scan.notProvisioned"),
          code: reading.uid,
        });
      }
    },
    [checkIn, t]
  );

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    activeCheckIn(code);
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
        <p className="mt-2 text-sm text-muted">
          {t("scan.eventNotFoundHint")}
        </p>
        <Link href="/dashboard" className="btn-secondary mt-6 inline-flex">{t("common.backToDashboard")}</Link>
      </div>
    );
  }

  // Session 14 — VIP fast-track takeover. Full-screen so it reads at a
  // glance in bright outdoor daylight (no reliance on the app's light/dark
  // theme, which is a display-preference concern, not a physical-lighting
  // one) — dark text on a bright gold ground, hard-coded rather than themed
  // so it stays maximum-contrast in every viewing condition.
  if (result?.kind === "vip") {
    return (
      <div
        role="alert"
        className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 p-6 text-center"
        style={{ backgroundColor: "#ffc300", color: "#1a1300" }}
      >
        <span className="text-[clamp(2.5rem,18vw,6.5rem)] leading-none" aria-hidden="true">👑</span>
        <p className="text-[clamp(1.75rem,9vw,3.5rem)] font-extrabold leading-[1.1] tracking-[0.01em]">
          {result.message}
        </p>
        {result.attendeeLabel && <p className="text-[clamp(1.25rem,6vw,1.75rem)] font-bold">{result.attendeeLabel}</p>}
        {result.ticketTypeName && <p className="text-[clamp(1rem,4vw,1.25rem)] font-semibold">{result.ticketTypeName}</p>}
        <p className="font-mono text-[clamp(0.9rem,3.5vw,1.125rem)] font-semibold tracking-widest opacity-[0.85]">
          {result.code}
        </p>
      </div>
    );
  }

  // Session D — every other result kind takes over the full screen too,
  // for the same "read it from across the gate" reason the VIP screen
  // above already does. attendeeLabel is the closest thing to an attendee
  // name this device ever has offline (a group-purchase member's own
  // chosen label — see ScanResult's own comment); falls back to the
  // ticket/vendor name, then the plain status message.
  if (result) {
    const tone = resultTone(result.kind);
    const title = result.attendeeLabel || result.ticketTypeName || result.message;
    const subtitle = result.attendeeLabel
      ? [result.ticketTypeName, result.boothNumber ? t("common.boothNumber", { number: result.boothNumber }) : null]
          .filter(Boolean)
          .join(" · ") || result.message
      : result.ticketTypeName
      ? result.message
      : null;
    const hint =
      result.kind === "refunded" || result.kind === "paymentFailed"
        ? t("scan.refundedHint")
        : result.kind === "paymentPending"
        ? t("scan.paymentPendingHint")
        : null;
    return (
      <ScanResultOverlay
        tone={tone}
        icon={resultIcon(tone)}
        title={title}
        subtitle={subtitle}
        hint={hint}
        code={result.code}
        durationMs={RESULT_AUTO_RESET_MS}
        onDone={() => setResult(null)}
      />
    );
  }

  return (
    <div className="min-h-screen bg-background" style={highContrast ? HIGH_CONTRAST_VARS : undefined}>
      <div className="mx-auto max-w-lg px-4 pb-20 pt-8 sm:px-6">
        <div className="flex items-center justify-between gap-2">
          <Link href={`/dashboard/events/${event.id}`} className="text-sm text-muted hover:text-foreground">
            ← {event.title}
          </Link>
          <Link href={`/scan/${event.id}/wallet`} className="text-sm font-medium text-accent-hover">
            {t("scan.chargeWalletsLink")}
          </Link>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">{t("scan.title")}</h1>
          <HighContrastToggle highContrast={highContrast} onToggle={toggleHighContrast} />
        </div>

        <div className="mt-4 flex gap-2">
          <button
            className={`min-h-12 flex-1 text-base ${mode === "attendee" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => { setMode("attendee"); setResult(null); }}
          >
            {t("scan.modeAttendees")}
          </button>
          <button
            className={`min-h-12 flex-1 text-base ${mode === "vendor" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => { setMode("vendor"); setResult(null); }}
          >
            {t("scan.modeVendors")}
          </button>
        </div>

        <p className="mt-3 text-sm text-muted">
          {!online && t("scan.offlinePrefix")}
          {mode === "attendee" ? (
            <>{t("scan.validatingAgainst")} {tickets.length} {tickets.length === 1 ? t("scan.ticket") : t("scan.tickets")}</>
          ) : (
            <>{t("scan.validatingAgainst")} {approvedVendors.length} {approvedVendors.length === 1 ? t("scan.vendor") : t("scan.vendors")}</>
          )}
        </p>

        <div className="card mt-5 flex items-center justify-between p-5">
          <div>
            <p className="text-sm uppercase tracking-wide text-muted">{t("scan.checkedIn")}</p>
            <p className="text-3xl font-extrabold">
              {mode === "attendee" ? `${checkedInCount} / ${tickets.length}` : `${vendorCheckedInCount} / ${approvedVendors.length}`}
            </p>
          </div>
          <div className="h-2 w-32 overflow-hidden rounded-full bg-surface2">
            <div
              className="h-full bg-ok transition-all"
              style={{
                width:
                  mode === "attendee"
                    ? `${tickets.length ? (checkedInCount / tickets.length) * 100 : 0}%`
                    : `${approvedVendors.length ? (vendorCheckedInCount / approvedVendors.length) * 100 : 0}%`,
              }}
            />
          </div>
        </div>

        <div className="mt-5">
          <CameraScanner onDetect={activeCheckIn} />
          {mode === "attendee" && <NFCScanner onDetect={handleNfcDetect} />}
        </div>

        <form onSubmit={onSubmit} className="flex gap-2">
          <input
            ref={inputRef}
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={mode === "attendee" ? t("scan.enterOrScan") : t("scan.enterOrScanVendor")}
            className="input min-h-12 font-mono text-base uppercase tracking-widest"
          />
          <button type="submit" className="btn-primary min-h-12 shrink-0 text-base">
            {mode === "attendee" ? t("scan.checkIn") : t("scan.checkInVendor")}
          </button>
        </form>
      </div>
    </div>
  );
}
