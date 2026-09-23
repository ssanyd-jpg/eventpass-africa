"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { db, newLocalId, type LocalDirectSaleTransaction } from "@/lib/db";
import { queueOp, flushOutbox, useOnlineStatus } from "@/lib/sync-engine";
import { useAppSession } from "@/lib/use-app-session";
import { useTranslation } from "@/lib/use-translation";
import { formatCents } from "@/lib/format";
import CameraScanner from "@/components/CameraScanner";
import NFCScanner, { type NFCReading } from "@/components/NFCScanner";
import Spinner from "@/components/Spinner";
import HighContrastToggle from "@/components/HighContrastToggle";
import { useHighContrast } from "@/lib/use-high-contrast";
import { HIGH_CONTRAST_VARS } from "@/lib/scan-high-contrast";
import { resolveCodeFromUid, isUidSuperseded, resolveTicketIdFromUid } from "@/lib/credentials";
import { resolveOfflineChargeMessage } from "@/lib/wallet-charge";
import { hasFeature } from "@/lib/event-modes";

// Session D — one-tap common amounts, sale mode only. Generalized to the
// event's own currency rather than hard-coding TZS, same "no currency
// assumption baked in" discipline CURRENCIES/formatCents already follow
// everywhere else in this app.
const QUICK_CHARGE_AMOUNTS_MAJOR = [5000, 10000, 20000];

// Session 28 — Direct Sale polls for STK-push confirmation every 5s, capped
// at 90s of waiting (shorter than OrderConfirmation's 3-minute checkout
// cap — a staff terminal has a queue of customers behind this one, a lone
// buyer on the checkout page doesn't). Same "cosmetic countdown, separate
// from the real timeout" split as PENDING_COUNTDOWN_SECONDS there.
const DIRECT_SALE_POLL_INTERVAL_MS = 5000;
const DIRECT_SALE_POLL_TIMEOUT_MS = 90 * 1000;
const DIRECT_SALE_COUNTDOWN_SECONDS = 30;

// Same network list as the buyer's own top-up form (account/wallet/[walletId]/page.tsx) —
// Session 15's split payment needs the same phone+network pair to STK-push
// the shortfall.
const NETWORKS = [
  { value: "MPESA", label: "M-Pesa" },
  { value: "TIGO", label: "Tigo Pesa" },
  { value: "AIRTEL", label: "Airtel Money" },
  { value: "HALOTEL", label: "HaloPesa" },
];

// Session 15 — shown instead of a flat decline when a charge's balance is
// insufficient: offers topping up the shortfall via AirPay and applying the
// charge in one step. Set from chargeWallet's decline branch (it already
// has the current balance from the just-synced wallet), cleared on confirm,
// cancel, or the next scan.
type SplitPrompt = {
  code: string;
  walletId: string;
  balanceCents: number;
  totalAmountCents: number;
  topUpAmountCents: number;
  currency: string;
  attendeeTicketId?: string;
};

type TerminalResult = {
  kind: "valid" | "declined" | "invalid" | "offline" | "recorded" | "notProvisioned" | "wristbandReplaced" | "leadCaptured";
  message: string;
  code: string;
  // Set only for a tap that selected a campaign — lets the reactive
  // banner-upgrade effect confirm the currently-displayed banner is still
  // THIS tap before overwriting it (staff may have already moved on to a
  // different attendee by the time the sync result arrives).
  tapClientId?: string;
  // Session D — a completed sale-mode charge's balance before/after, for
  // the "clearer balance before/after" spec item. Derived, not stored:
  // balanceAfterCents is the wallet's real post-sync balance, and before
  // is just that plus what was just charged.
  balanceBeforeCents?: number;
  balanceAfterCents?: number;
  currency?: string;
};

export default function WalletChargeTerminalPage() {
  const { eventId: rawEventId } = useParams<{ eventId: string }>();
  const eventId = decodeURIComponent(rawEventId);
  const router = useRouter();
  const { user, status } = useAppSession();
  const online = useOnlineStatus();
  const { t } = useTranslation();

  // Previously this page had no auth check at all. Middleware already
  // redirects GATE_CREW away from this route server-side; this covers the
  // baseline "must be signed in" case and the offline-cached-shell case
  // (see src/middleware.ts).
  useEffect(() => {
    if (status !== "loading" && !user) router.push(`/login?callbackUrl=/scan/${eventId}/wallet`);
    if (user?.organizationRole === "GATE_CREW") router.replace("/dashboard");
  }, [status, user, router, eventId]);
  const [mode, setMode] = useState<"sale" | "tap" | "lead" | "directSale">("sale");
  const [code, setCode] = useState("");
  const [amountMajor, setAmountMajor] = useState("");
  const [item, setItem] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [sponsorId, setSponsorId] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [note, setNote] = useState("");
  const [showNoteField, setShowNoteField] = useState(false);
  // Session 19 — exhibitor lead capture's own note, kept separate from the
  // sponsor tap's `note` state above even though both render as the same
  // "+ Add a note" textarea pattern, since the two modes' vendorId/sponsorId
  // selections are already independent state.
  const [leadNote, setLeadNote] = useState("");
  const [showLeadNoteField, setShowLeadNoteField] = useState(false);
  const [result, setResult] = useState<TerminalResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [splitPrompt, setSplitPrompt] = useState<SplitPrompt | null>(null);
  const [splitPhone, setSplitPhone] = useState("");
  const [splitNetwork, setSplitNetwork] = useState(NETWORKS[0].value);
  const [splitBusy, setSplitBusy] = useState(false);
  // Tracks the most recent tap that redeemed a campaign, so the result
  // banner can reactively upgrade from "Tap recorded." to the actual
  // redemption outcome once the outbox flushes and the server's answer
  // syncs back — never blocks entering the next attendee in the meantime.
  const [pendingTapClientId, setPendingTapClientId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { highContrast, toggle: toggleHighContrast } = useHighContrast();

  // Session 28 — Direct Sale form + the currently-polled transaction (by
  // clientId, same reason pendingTapClientId above uses the clientId INDEX
  // rather than .get() by primary key: applyChargeDirectSaleResult remaps
  // the local temp id to the server's real id, so a primary-key lookup
  // would go stale the instant the outbox flushes).
  const [dsAmountMajor, setDsAmountMajor] = useState("");
  const [dsItem, setDsItem] = useState("");
  const [dsPhone, setDsPhone] = useState("");
  const [dsNetwork, setDsNetwork] = useState(NETWORKS[0].value);
  const [dsBusy, setDsBusy] = useState(false);
  const [dsError, setDsError] = useState<string | null>(null);
  const [dsActiveClientId, setDsActiveClientId] = useState<string | null>(null);
  const [dsPollTimedOut, setDsPollTimedOut] = useState(false);
  const [dsCancelling, setDsCancelling] = useState(false);
  const [dsCountdown, setDsCountdown] = useState(DIRECT_SALE_COUNTDOWN_SECONDS);

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

  const sponsorCampaigns = useLiveQuery(async () => {
    if (!sponsorId) return [];
    return db.sponsorCampaigns.where("sponsorId").equals(sponsorId).toArray();
  }, [sponsorId]);
  const redeemableCampaigns = useMemo(() => {
    const now = new Date();
    return (sponsorCampaigns ?? []).filter(
      (c) =>
        c.active &&
        (!c.expiresAt || new Date(c.expiresAt) > now) &&
        (c.maxRedemptions == null || c.redemptionCount < c.maxRedemptions)
    );
  }, [sponsorCampaigns]);

  // A campaign belongs to one sponsor — switching sponsors invalidates
  // whatever was selected.
  useEffect(() => {
    setCampaignId("");
  }, [sponsorId]);

  // Reactively upgrades the result banner once this tap's server-
  // authoritative row has synced back — see pendingTapClientId above.
  // Looked up by the clientId INDEX, not .get() by primary key: once the
  // outbox flushes, applySponsorTapResult deletes the optimistic
  // temp-id-keyed row and re-puts it under the server's real id, so a
  // primary-key .get(pendingTapClientId) would find nothing post-sync and
  // this banner would never upgrade.
  const pendingTapTx = useLiveQuery(async () => {
    if (!pendingTapClientId) return undefined;
    return db.walletTransactions.where("clientId").equals(pendingTapClientId).first();
  }, [pendingTapClientId]);
  useEffect(() => {
    if (!pendingTapTx || pendingTapTx.syncStatus !== "synced") return;
    const message = pendingTapTx.campaignId
      ? t("wallet.tapRecordedCouponRedeemed")
      : pendingTapTx.campaignRejectReason === "CAMPAIGN_ALREADY_REDEEMED"
      ? t("wallet.tapRecordedCouponUsed")
      : pendingTapTx.campaignRejectReason === "CAMPAIGN_MAX_REDEEMED"
      ? t("wallet.tapRecordedCouponFull")
      : pendingTapTx.campaignRejectReason === "CAMPAIGN_EXPIRED" || pendingTapTx.campaignRejectReason === "CAMPAIGN_INACTIVE"
      ? t("wallet.tapRecordedCouponExpired")
      : null;
    if (message) {
      // Only overwrite the banner if it's still showing THIS tap — staff
      // may have already scanned a different attendee by the time this
      // sync result lands, and that newer banner must never be clobbered.
      setResult((r) => (r && r.tapClientId === pendingTapTx.clientId ? { ...r, message } : r));
    }
    setPendingTapClientId(null);
  }, [pendingTapTx, t]);

  // Session 28 — the Direct Sale currently being confirmed (if any).
  const dsTx = useLiveQuery(async () => {
    if (!dsActiveClientId) return undefined;
    return db.directSaleTransactions.where("clientId").equals(dsActiveClientId).first();
  }, [dsActiveClientId]);

  function checkDirectSaleStatus(tx: LocalDirectSaleTransaction) {
    queueOp("CHECK_DIRECT_SALE_STATUS", {
      clientId: newLocalId(),
      directSaleId: tx.id,
      directSaleClientId: tx.clientId,
    });
  }

  // Purely cosmetic countdown alongside the spinner — same split from the
  // real timeout (DIRECT_SALE_POLL_TIMEOUT_MS, tracked via dsPollTimedOut
  // below) as OrderConfirmation.tsx's own PENDING_COUNTDOWN_SECONDS.
  useEffect(() => {
    if (dsTx?.status !== "PENDING") return;
    setDsCountdown(DIRECT_SALE_COUNTDOWN_SECONDS);
    const interval = setInterval(() => setDsCountdown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(interval);
  }, [dsTx?.id, dsTx?.status]);

  // Automatic polling while PENDING — every 5s, capped at 90s. Same
  // client-side-loop-hitting-the-outbox shape as OrderConfirmation.tsx's own
  // polling effect (see its header comment for why this can't be a
  // server-side wait), including the sticky stoppedRef guard against a
  // straggler CHECK_DIRECT_SALE_STATUS reply bouncing status back to
  // PENDING right after Cancel is tapped.
  const dsTxRef = useRef(dsTx);
  dsTxRef.current = dsTx;
  const dsStoppedRef = useRef(false);
  useEffect(() => {
    dsStoppedRef.current = false;
  }, [dsTx?.id]);
  useEffect(() => {
    if (dsStoppedRef.current || !dsTx || dsTx.status !== "PENDING") {
      setDsPollTimedOut(false);
      return;
    }
    checkDirectSaleStatus(dsTx);
    const startedAt = Date.now();
    const interval = setInterval(() => {
      if (dsStoppedRef.current) {
        clearInterval(interval);
        return;
      }
      if (Date.now() - startedAt >= DIRECT_SALE_POLL_TIMEOUT_MS) {
        setDsPollTimedOut(true);
        clearInterval(interval);
        return;
      }
      checkDirectSaleStatus(dsTxRef.current!);
    }, DIRECT_SALE_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dsTx?.id, dsTx?.status]);

  // Refs so the scan handlers' identity stays stable across renders —
  // CameraScanner restarts its stream whenever onDetect changes, same
  // reasoning as the gate scanner's ref-stabilization.
  const eventRef = useRef(event);
  eventRef.current = event;
  const vendorIdRef = useRef(vendorId);
  vendorIdRef.current = vendorId;
  const approvedVendorsRef = useRef(approvedVendors);
  approvedVendorsRef.current = approvedVendors;
  const amountMajorRef = useRef(amountMajor);
  amountMajorRef.current = amountMajor;
  const itemRef = useRef(item);
  itemRef.current = item;
  const sponsorIdRef = useRef(sponsorId);
  sponsorIdRef.current = sponsorId;
  const campaignIdRef = useRef(campaignId);
  campaignIdRef.current = campaignId;
  const noteRef = useRef(note);
  noteRef.current = note;
  const leadNoteRef = useRef(leadNote);
  leadNoteRef.current = leadNote;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const onlineRef = useRef(online);
  onlineRef.current = online;

  const chargeWallet = useCallback(async (rawCode: string, attendeeTicketId?: string) => {
    const normalized = rawCode.trim().toUpperCase();
    const event = eventRef.current;
    if (!normalized || !event) return;

    // A new scan always supersedes whatever split prompt was showing —
    // staff moved on to a different attendee/amount.
    setSplitPrompt(null);
    setSplitPhone("");

    const vendorId = vendorIdRef.current;
    const amountCents = Math.round(parseFloat(amountMajorRef.current || "0") * 100);

    if (!onlineRef.current) {
      // Session 15 — split payment needs a live AirPay STK push and can
      // never work offline. The locally-synced wallet balance is already
      // on this device (periodic pull), so if it shows this charge WOULD
      // need a split, say so specifically rather than the generic offline
      // message — staff shouldn't think the whole terminal is down over a
      // case the feature was never going to support offline anyway.
      const localWallet = amountCents > 0 ? await db.wallets.where("code").equals(normalized).first() : undefined;
      setResult({
        kind: "offline",
        message: resolveOfflineChargeMessage(localWallet?.balanceCents ?? null, amountCents),
        code: normalized,
      });
      return;
    }
    if (!vendorId) {
      setResult({ kind: "invalid", message: t("wallet.pickVendorFirst"), code: normalized });
      return;
    }
    if (!amountCents || amountCents < 1) {
      setResult({ kind: "invalid", message: t("wallet.enterAmountFirst"), code: normalized });
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
      item: itemRef.current.trim() || undefined,
      attendeeTicketId,
    });
    await flushOutbox();
    const tx = await db.walletTransactions.where("clientId").equals(clientId).first();
    setBusy(false);

    if (!tx) {
      setResult({ kind: "invalid", message: t("wallet.couldntReachServer"), code: normalized });
      return;
    }
    // Session 13 — a group wallet's confirmation names the group so staff
    // know it's a shared pool, not one person's own balance.
    const wallet = tx.walletId ? await db.wallets.get(tx.walletId) : undefined;
    const groupSuffix = wallet?.isGroupWallet
      ? t("wallet.groupWalletSuffix", {
          groupName: wallet.groupName ?? t("wallet.groupFallbackName"),
          memberSuffix: tx.spentByMemberName ? t("wallet.groupMemberSuffix", { name: tx.spentByMemberName }) : "",
        })
      : "";
    if (tx.status === "FAILED") {
      // Session 15 — a plain insufficient-balance decline (the one exact
      // message handleChargeWallet ever sets for this) offers a split
      // payment instead of just declining, as long as the wallet actually
      // resolved (never for an unknown/unresolved code). Group wallets are
      // included — the shortfall math and the eventual SPLIT_PAYMENT charge
      // both work the same way regardless of whose wallet it is.
      if (tx.providerMessage === "Insufficient balance" && wallet) {
        setSplitPrompt({
          code: normalized,
          walletId: wallet.id,
          balanceCents: wallet.balanceCents,
          totalAmountCents: amountCents,
          topUpAmountCents: amountCents - wallet.balanceCents,
          currency: tx.currency,
          attendeeTicketId,
        });
        return;
      }
      setResult({ kind: "declined", message: t("wallet.declinedInsufficient", { groupSuffix }), code: normalized });
      return;
    }
    if (tx.status === "COMPLETED") {
      setResult({
        kind: "valid",
        message: t("wallet.chargedMessage", { amount: formatCents(amountCents, tx.currency), groupSuffix }),
        code: normalized,
        balanceAfterCents: wallet?.balanceCents,
        balanceBeforeCents: wallet ? wallet.balanceCents + amountCents : undefined,
        currency: tx.currency,
      });
      return;
    }
    setResult({ kind: "invalid", message: t("wallet.couldntConfirmCharge"), code: normalized });
  }, [t]);

  const confirmSplitPayment = useCallback(async () => {
    const prompt = splitPrompt;
    const event = eventRef.current;
    if (!prompt || !event) return;
    if (!splitPhone.trim()) {
      setResult({ kind: "invalid", message: t("wallet.enterPhoneForTopUp"), code: prompt.code });
      return;
    }

    setSplitBusy(true);
    const clientId = newLocalId();
    // Non-optimistic, same reasoning as chargeWallet — wait for the real
    // result before telling staff the purchase went through.
    await queueOp("SPLIT_PAYMENT", {
      clientId,
      walletCode: prompt.code,
      vendorId: vendorIdRef.current,
      eventId: event.id,
      eventClientId: event.clientId,
      totalAmountCents: prompt.totalAmountCents,
      walletContributionCents: prompt.balanceCents,
      topUpAmountCents: prompt.topUpAmountCents,
      phoneNumber: splitPhone.trim(),
      mobileNetwork: splitNetwork,
      item: itemRef.current.trim() || undefined,
      attendeeTicketId: prompt.attendeeTicketId,
    });
    await flushOutbox();
    const tx = await db.walletTransactions.where("clientId").equals(clientId).first();
    setSplitBusy(false);
    setSplitPrompt(null);
    setSplitPhone("");

    if (!tx) {
      setResult({ kind: "invalid", message: t("wallet.couldntReachServer"), code: prompt.code });
      return;
    }
    if (tx.status === "COMPLETED") {
      const networkLabel = NETWORKS.find((n) => n.value === splitNetwork)?.label ?? splitNetwork;
      setResult({
        kind: "valid",
        message: t("wallet.splitPaymentComplete", {
          walletAmount: formatCents(prompt.balanceCents, tx.currency),
          topUpAmount: formatCents(prompt.topUpAmountCents, tx.currency),
          network: networkLabel,
        }),
        code: prompt.code,
      });
      return;
    }
    setResult({
      kind: "declined",
      message: tx.providerMessage ?? t("wallet.splitPaymentFailed"),
      code: prompt.code,
    });
  }, [splitPrompt, splitPhone, splitNetwork, t]);

  const cancelSplitPayment = useCallback(() => {
    setSplitPrompt(null);
    setSplitPhone("");
  }, []);

  // Session 28 — Direct Sale: no walletCode/vendor to resolve at all, just
  // the event and whichever staff account is running this terminal (the
  // server derives that from the session, not from anything in this
  // payload). Never optimistic, same reasoning as chargeWallet — this waits
  // for the real CHARGE_DIRECT_SALE result before switching into polling
  // mode, so a hard decline (e.g. an invalid number) surfaces immediately
  // rather than showing a fake "sent" state.
  const chargeDirectSale = useCallback(async () => {
    setDsError(null);
    const event = eventRef.current;
    if (!event) return;
    const amountCents = Math.round(parseFloat(dsAmountMajor || "0") * 100);
    if (!amountCents || amountCents < 1) {
      setDsError(t("wallet.enterAmountFirst"));
      return;
    }
    if (!dsPhone.trim()) {
      setDsError(t("wallet.enterCustomerPhoneFirst"));
      return;
    }

    setDsBusy(true);
    const clientId = newLocalId();
    await queueOp("CHARGE_DIRECT_SALE", {
      clientId,
      eventId: event.id,
      eventClientId: event.clientId,
      amountCents,
      customerPhone: dsPhone.trim(),
      mobileNetwork: dsNetwork,
      item: dsItem.trim() || undefined,
    });
    await flushOutbox();
    setDsBusy(false);

    const tx = await db.directSaleTransactions.where("clientId").equals(clientId).first();
    if (!tx) {
      setDsError(t("wallet.couldntReachServer"));
      return;
    }
    setDsActiveClientId(clientId);
  }, [dsAmountMajor, dsPhone, dsNetwork, dsItem, t]);

  const cancelDirectSale = useCallback(async () => {
    if (!dsTx) return;
    dsStoppedRef.current = true;
    setDsCancelling(true);
    await queueOp("CANCEL_DIRECT_SALE", {
      clientId: newLocalId(),
      directSaleId: dsTx.id,
      directSaleClientId: dsTx.clientId,
    });
    await flushOutbox();
    setDsCancelling(false);
  }, [dsTx]);

  // "Try again" for a FAILED/CANCELLED/timed-out sale, and the "charge
  // another customer" reset after a CONFIRMED one — both just drop back to
  // the entry form. Amount/item/phone/network are left as they were (a
  // declined number is usually a typo staff wants to fix, not retype from
  // scratch), except after a genuine CONFIRMED sale, where starting the next
  // customer from a blank amount is the safer default.
  const resetDirectSale = useCallback((clearForm: boolean) => {
    setDsActiveClientId(null);
    setDsPollTimedOut(false);
    setDsError(null);
    if (clearForm) {
      setDsAmountMajor("");
      setDsItem("");
      setDsPhone("");
    }
  }, []);

  // Second parameter unused here — recordTap has no member-attribution
  // concept — but kept so activeHandler's two branches share one call
  // signature (see chargeWallet's own attendeeTicketId).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const recordTap = useCallback(async (rawCode: string, _attendeeTicketId?: string) => {
    const normalized = rawCode.trim().toUpperCase();
    const event = eventRef.current;
    const sponsorId = sponsorIdRef.current;
    if (!normalized || !event) return;
    if (!sponsorId) {
      setResult({ kind: "invalid", message: t("wallet.pickSponsorFirst"), code: normalized });
      return;
    }

    const clientId = newLocalId();
    const campaignId = campaignIdRef.current;
    await queueOp("SPONSOR_TAP", {
      clientId,
      walletCode: normalized,
      sponsorId,
      eventId: event.id,
      eventClientId: event.clientId,
      note: noteRef.current.trim() || undefined,
      campaignId: campaignId || undefined,
    });

    setResult({ kind: "recorded", message: t("wallet.tapRecorded"), code: normalized, tapClientId: campaignId ? clientId : undefined });
    if (campaignId) setPendingTapClientId(clientId);
    // Reset for the next attendee — same discipline as the code input reset
    // in onSubmit below, applied here too since scanner-triggered taps
    // (CameraScanner/NFCScanner) bypass onSubmit entirely.
    setNote("");
    setShowNoteField(false);
    setCampaignId("");
  }, [t]);

  // Session 19 — exhibitor lead capture: no charge, no wallet involvement at
  // all, so this resolves an attendee's CREDENTIAL directly (nfcUid or a
  // scanned ticket QR — same resolution the session/timing scanners use
  // server-side, see resolveCredentialForTiming), never a wallet code the
  // way chargeWallet/recordTap do. rawCode from CameraScanner/manual entry
  // is always treated as a ticket code; handleNfcDetect below calls this
  // with nfcUid directly instead, bypassing resolveCodeFromUid entirely.
  const captureLead = useCallback(async (input: { ticketCode?: string; nfcUid?: string }) => {
    const event = eventRef.current;
    const vendorId = vendorIdRef.current;
    const displayCode = (input.ticketCode ?? input.nfcUid ?? "").toUpperCase();
    if (!event) return;
    if (!vendorId) {
      setResult({ kind: "invalid", message: t("wallet.pickExhibitorFirst"), code: displayCode });
      return;
    }

    const clientId = newLocalId();
    const vendor = (approvedVendorsRef.current ?? []).find((v) => v.id === vendorId);
    await queueOp("CAPTURE_EXHIBITOR_LEAD", {
      clientId,
      eventId: event.id,
      eventClientId: event.clientId,
      vendorId,
      vendorClientId: vendor?.clientId ?? undefined,
      ticketCode: input.ticketCode,
      nfcUid: input.nfcUid,
      notes: leadNoteRef.current.trim() || undefined,
    });

    setResult({ kind: "leadCaptured", message: t("wallet.leadCaptured"), code: displayCode });
    setLeadNote("");
    setShowLeadNoteField(false);
  }, [t]);

  const activeHandler = useMemo(
    () =>
      mode === "sale"
        ? chargeWallet
        : mode === "tap"
        ? recordTap
        : mode === "directSale"
        ? // Direct Sale has no wallet/ticket code to scan at all — the
          // CameraScanner/NFCScanner/code-entry form below are hidden
          // entirely for this mode, so this branch is never actually
          // invoked, but activeHandler still needs a same-shaped no-op
          // rather than a hole in the ternary.
          async () => {}
        : (rawCode: string) => captureLead({ ticketCode: rawCode.trim().toUpperCase() }),
    [mode, chargeWallet, recordTap, captureLead]
  );

  // NFC uid resolution first (a wristband provisioned via /scan/[eventId]/
  // provision), falling back to the decoded NDEF text (a tag bound the old
  // way, via bindNfc() on the buyer's own wallet page) — chargeWallet/
  // recordTap themselves are untouched, they still just take a code string.
  // Lead capture mode is the one exception: it needs the raw nfcUid itself
  // (or the raw scanned ticket code), not a wallet-code resolution, so it
  // branches out via modeRef before any of that.
  const handleNfcDetect = useCallback(
    async (reading: NFCReading) => {
      if (modeRef.current === "lead") {
        if (reading.uid) captureLead({ nfcUid: reading.uid });
        return;
      }
      const code = (reading.uid ? await resolveCodeFromUid(reading.uid, "wallet") : null) ?? reading.text;
      if (code) {
        // Session 13 — this same uid may also have a sibling ticket-linked
        // Credential row (every wristband provisioned with a ticket gets
        // both) — pass it along so a charge on a group wallet can be
        // attributed to this specific member (see CHARGE_WALLET's
        // attendeeTicketId). Harmless/unused for a non-group wallet.
        const attendeeTicketId = reading.uid ? await resolveTicketIdFromUid(reading.uid) : null;
        activeHandler(code, attendeeTicketId ?? undefined);
        return;
      }
      if (reading.uid) {
        const replaced = await isUidSuperseded(reading.uid, "wallet");
        setResult({
          kind: replaced ? "wristbandReplaced" : "notProvisioned",
          message: replaced ? t("scan.wristbandReplaced") : t("scan.notProvisioned"),
          code: reading.uid,
        });
      }
    },
    [activeHandler, captureLead, t]
  );

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    activeHandler(code);
    setCode("");
    inputRef.current?.focus();
  }

  if (!user || user.organizationRole === "GATE_CREW") return null;

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
      <Link href={`/scan/${event.id}`} className="text-sm text-muted hover:text-foreground">
        ← {event.title} {t("wallet.backToGateScannerSuffix")}
      </Link>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{t("wallet.title")}</h1>
        <HighContrastToggle highContrast={highContrast} onToggle={toggleHighContrast} />
      </div>

      <div className="mt-4 flex gap-2">
        <button
          className={`min-h-12 flex-1 text-base ${mode === "sale" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => { setMode("sale"); setResult(null); setSplitPrompt(null); }}
        >
          {t("wallet.modeSale")}
        </button>
        <button
          className={`min-h-12 flex-1 text-base ${mode === "tap" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => { setMode("tap"); setResult(null); setSplitPrompt(null); }}
        >
          {t("wallet.modeTap")}
        </button>
        {/* Session 19 — exhibitor lead capture only makes sense for a
            CONFERENCE event, where vendors are exhibitors at booths rather
            than food/merch stalls. */}
        {hasFeature(event.eventType, "exhibitorLeads") && (
          <button
            className={`min-h-12 flex-1 text-base ${mode === "lead" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => { setMode("lead"); setResult(null); setSplitPrompt(null); }}
          >
            {t("wallet.modeLead")}
          </button>
        )}
        <button
          className={`min-h-12 flex-1 text-base ${mode === "directSale" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => { setMode("directSale"); setResult(null); setSplitPrompt(null); }}
        >
          {t("wallet.modeDirectSale")}
        </button>
      </div>

      {!online && mode === "sale" && (
        <p className="mt-3 text-sm text-warn">{t("wallet.offlineChargeWarning")}</p>
      )}

      {mode === "sale" ? (
        <div className="card mt-5 space-y-4 p-5">
          <div>
            <label className="label" htmlFor="vendor">{t("wallet.chargingAsLabel")}</label>
            <select id="vendor" className="input min-h-12 text-base" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">{t("wallet.selectVendor")}</option>
              {approvedVendors.map((v) => (
                <option key={v.id} value={v.id}>{v.name}{v.boothNumber ? ` (${t("common.boothNumber", { number: v.boothNumber })})` : ""}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="amount">{t("wallet.amountLabel", { currency: event.currency })}</label>
            <input
              id="amount"
              type="number"
              min="1"
              step="500"
              className="input min-h-16 text-center text-4xl font-extrabold tabular-nums"
              value={amountMajor}
              onChange={(e) => setAmountMajor(e.target.value)}
            />
            <div className="mt-2 grid grid-cols-3 gap-2">
              {QUICK_CHARGE_AMOUNTS_MAJOR.map((amount) => (
                <button
                  key={amount}
                  type="button"
                  className="btn-secondary min-h-12 text-sm font-bold"
                  onClick={() => setAmountMajor(String(amount))}
                >
                  {formatCents(amount * 100, event.currency)}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="label" htmlFor="item">{t("wallet.itemLabel")}</label>
            <input
              id="item"
              className="input"
              placeholder={t("wallet.itemPlaceholder")}
              maxLength={120}
              value={item}
              onChange={(e) => setItem(e.target.value)}
            />
          </div>
        </div>
      ) : mode === "tap" ? (
        <div className="card mt-5 space-y-3 p-5">
          <div>
            <label className="label" htmlFor="sponsor">{t("wallet.sponsorLabel")}</label>
            <select id="sponsor" className="input" value={sponsorId} onChange={(e) => setSponsorId(e.target.value)}>
              <option value="">{t("wallet.selectSponsor")}</option>
              {(sponsors ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.name} ({s.tier})</option>
              ))}
            </select>
          </div>
          {sponsorId && (
            <div>
              <label className="label" htmlFor="campaign">{t("wallet.couponLabel")}</label>
              <select id="campaign" className="input" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                <option value="">{t("wallet.noCampaign")}</option>
                {redeemableCampaigns.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} ({c.code})</option>
                ))}
              </select>
            </div>
          )}
          {showNoteField ? (
            <div>
              <label className="label" htmlFor="tapNote">{t("wallet.noteLabel")}</label>
              <textarea
                id="tapNote"
                className="input min-h-16"
                placeholder={t("wallet.tapNotePlaceholder")}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
              />
            </div>
          ) : (
            <button
              type="button"
              className="text-sm font-medium text-accent-hover"
              onClick={() => setShowNoteField(true)}
            >
              {t("wallet.addNote")}
            </button>
          )}
        </div>
      ) : mode === "lead" ? (
        <div className="card mt-5 space-y-3 p-5">
          <div>
            <label className="label" htmlFor="exhibitor">{t("wallet.exhibitorLabel")}</label>
            <select id="exhibitor" className="input" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">{t("wallet.selectExhibitor")}</option>
              {approvedVendors.map((v) => (
                <option key={v.id} value={v.id}>{v.name}{v.boothNumber ? ` (${t("common.boothNumber", { number: v.boothNumber })})` : ""}</option>
              ))}
            </select>
          </div>
          {showLeadNoteField ? (
            <div>
              <label className="label" htmlFor="leadNote">{t("wallet.noteLabel")}</label>
              <textarea
                id="leadNote"
                className="input min-h-16"
                placeholder={t("wallet.leadNotePlaceholder")}
                value={leadNote}
                onChange={(e) => setLeadNote(e.target.value)}
                maxLength={500}
              />
            </div>
          ) : (
            <button
              type="button"
              className="text-sm font-medium text-accent-hover"
              onClick={() => setShowLeadNoteField(true)}
            >
              {t("wallet.addNote")}
            </button>
          )}
        </div>
      ) : !online ? (
        // Session 28 — Direct Sale needs a live STK push and can never work
        // offline (there's no local cache to fall back to, unlike sale
        // mode's wallet balance) — blocked outright, same "say specifically
        // why, don't just look broken" discipline as chargeWallet's own
        // offline branch.
        <div className="card mt-5 space-y-2 p-5 text-center">
          <p className="font-semibold text-warn">{t("wallet.directSaleOfflineTitle")}</p>
          <p className="text-sm text-muted">{t("wallet.directSaleOfflineMessage")}</p>
        </div>
      ) : dsTx ? (
        <div className="card mt-5 space-y-4 p-5 text-center">
          <p className="text-2xl font-extrabold tabular-nums">{formatCents(dsTx.amountCents, dsTx.currency)}</p>
          <p className="text-sm text-muted">
            {dsTx.customerPhone} · {NETWORKS.find((n) => n.value === dsTx.mobileNetwork)?.label ?? dsTx.mobileNetwork}
          </p>

          {dsTx.status === "PENDING" && !dsPollTimedOut && (
            <div className="inline-flex flex-col items-center gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
              <span className="flex items-center gap-2">
                <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-warn border-t-transparent" />
                {dsCountdown > 0
                  ? t("wallet.directSalePendingHint", {
                      network: NETWORKS.find((n) => n.value === dsTx.mobileNetwork)?.label ?? dsTx.mobileNetwork,
                      countdown: String(dsCountdown),
                    })
                  : t("wallet.directSaleStillConfirming")}
              </span>
              <div className="flex gap-3">
                <button type="button" className="font-medium text-accent-hover underline" onClick={() => checkDirectSaleStatus(dsTx)}>
                  {t("wallet.directSaleCheckStatus")}
                </button>
                <button type="button" className="font-medium text-danger underline disabled:opacity-50" disabled={dsCancelling} onClick={cancelDirectSale}>
                  {dsCancelling ? t("wallet.directSaleCancelling") : t("wallet.directSaleCancelPayment")}
                </button>
              </div>
            </div>
          )}

          {(dsTx.status === "FAILED" || dsTx.status === "CANCELLED" || (dsTx.status === "PENDING" && dsPollTimedOut)) && (
            <div className="inline-flex flex-col items-center gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
              <span>
                {dsTx.status === "CANCELLED"
                  ? t("wallet.directSaleCancelledMessage")
                  : dsTx.status === "PENDING"
                  ? t("wallet.directSaleTimedOutMessage")
                  : t("wallet.directSaleFailedMessage")}
              </span>
              <div className="flex items-center gap-3">
                <button type="button" className="font-medium text-accent-hover underline" onClick={() => resetDirectSale(false)}>
                  {t("wallet.directSaleTryAgain")}
                </button>
                {dsTx.status === "PENDING" && (
                  <button type="button" className="font-medium underline disabled:opacity-50" disabled={dsCancelling} onClick={cancelDirectSale}>
                    {dsCancelling ? t("wallet.directSaleCancelling") : t("wallet.directSaleCancelPayment")}
                  </button>
                )}
              </div>
            </div>
          )}

          {dsTx.status === "CONFIRMED" && (
            <div className="rounded-xl border border-ok/40 bg-ok/10 p-4">
              <p className="text-lg font-extrabold text-ok">
                ✓{" "}
                {t("wallet.directSaleConfirmedMessage", {
                  amount: formatCents(dsTx.amountCents, dsTx.currency),
                  network: NETWORKS.find((n) => n.value === dsTx.mobileNetwork)?.label ?? dsTx.mobileNetwork,
                })}
              </p>
              <button type="button" className="btn-secondary mt-3" onClick={() => resetDirectSale(true)}>
                {t("wallet.directSaleCharge")}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="card mt-5 space-y-4 p-5">
          <div>
            <label className="label" htmlFor="dsAmount">{t("wallet.amountLabel", { currency: event.currency })}</label>
            <input
              id="dsAmount"
              type="number"
              min="1"
              step="500"
              className="input min-h-16 text-center text-4xl font-extrabold tabular-nums"
              value={dsAmountMajor}
              onChange={(e) => setDsAmountMajor(e.target.value)}
            />
            <div className="mt-2 grid grid-cols-3 gap-2">
              {QUICK_CHARGE_AMOUNTS_MAJOR.map((amount) => (
                <button
                  key={amount}
                  type="button"
                  className="btn-secondary min-h-12 text-sm font-bold"
                  onClick={() => setDsAmountMajor(String(amount))}
                >
                  {formatCents(amount * 100, event.currency)}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="label" htmlFor="dsItem">{t("wallet.itemLabel")}</label>
            <input
              id="dsItem"
              className="input"
              placeholder={t("wallet.itemPlaceholder")}
              maxLength={120}
              value={dsItem}
              onChange={(e) => setDsItem(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="dsNetwork">{t("wallet.networkLabel")}</label>
              <select id="dsNetwork" className="input" value={dsNetwork} onChange={(e) => setDsNetwork(e.target.value)}>
                {NETWORKS.map((n) => (
                  <option key={n.value} value={n.value}>{n.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="dsPhone">{t("wallet.customerPhoneLabel")}</label>
              <input
                id="dsPhone"
                className="input"
                placeholder="+255 7XX XXX XXX"
                value={dsPhone}
                onChange={(e) => setDsPhone(e.target.value)}
              />
            </div>
          </div>
          {dsError && <p className="text-sm text-danger">{dsError}</p>}
          <button type="button" disabled={dsBusy} className="btn-primary min-h-14 w-full text-lg font-bold" onClick={chargeDirectSale}>
            {dsBusy ? t("wallet.directSaleSending") : t("wallet.directSaleCharge")}
          </button>
        </div>
      )}

      {mode !== "directSale" && (
        <div className="mt-5">
          <CameraScanner onDetect={activeHandler} />
          <NFCScanner onDetect={handleNfcDetect} />
        </div>
      )}

      {mode !== "directSale" && (
        <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row">
          <input
            ref={inputRef}
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={mode === "lead" ? t("wallet.enterOrScanTicket") : t("wallet.enterOrScanWallet")}
            className="input min-h-12 font-mono text-base uppercase tracking-widest"
          />
          <button type="submit" disabled={busy} className="btn-primary min-h-14 shrink-0 text-lg font-bold sm:min-h-12">
            {busy ? "…" : mode === "sale" ? t("wallet.charge") : mode === "tap" ? t("wallet.recordTapButton") : t("wallet.captureLeadButton")}
          </button>
        </form>
      )}

      {splitPrompt && (
        <div className="mt-5 rounded-xl border border-warn/40 bg-warn/10 p-5">
          <p className="font-mono text-sm font-bold tracking-widest">{splitPrompt.code}</p>
          <p className="mt-2 text-sm">
            {t("wallet.yourBalanceLabel")} <strong>{formatCents(splitPrompt.balanceCents, splitPrompt.currency)}</strong>. {t("wallet.amountDueLabel")}{" "}
            <strong>{formatCents(splitPrompt.totalAmountCents, splitPrompt.currency)}</strong>.
          </p>
          <p className="mt-1 text-sm font-semibold text-warn">
            {t("wallet.topUpPrompt", { amount: formatCents(splitPrompt.topUpAmountCents, splitPrompt.currency) })}
          </p>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="splitNetwork">{t("wallet.networkLabel")}</label>
              <select id="splitNetwork" className="input" value={splitNetwork} onChange={(e) => setSplitNetwork(e.target.value)}>
                {NETWORKS.map((n) => (
                  <option key={n.value} value={n.value}>{n.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="splitPhone">{t("wallet.attendeePhoneLabel")}</label>
              <input
                id="splitPhone"
                className="input"
                placeholder="+255 7XX XXX XXX"
                value={splitPhone}
                onChange={(e) => setSplitPhone(e.target.value)}
              />
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <button type="button" disabled={splitBusy} className="btn-primary flex-1" onClick={confirmSplitPayment}>
              {splitBusy ? "…" : t("wallet.topUpAndPay")}
            </button>
            <button type="button" disabled={splitBusy} className="btn-secondary flex-1" onClick={cancelSplitPayment}>
              {t("wallet.cancel")}
            </button>
          </div>
        </div>
      )}

      {!splitPrompt && result && (
        <div
          className={`mt-5 rounded-xl border p-5 text-center ${
            result.kind === "valid" || result.kind === "recorded" || result.kind === "leadCaptured"
              ? "border-ok/40 bg-ok/10"
              : result.kind === "declined" || result.kind === "offline" || result.kind === "notProvisioned" || result.kind === "wristbandReplaced"
              ? "border-warn/40 bg-warn/10"
              : "border-danger/40 bg-danger/10"
          }`}
        >
          <p className="font-mono text-lg font-bold tracking-widest">{result.code}</p>
          <p
            className={`mt-1 text-2xl font-extrabold ${
              result.kind === "valid" || result.kind === "recorded" || result.kind === "leadCaptured"
                ? "text-ok"
                : result.kind === "declined" || result.kind === "offline" || result.kind === "notProvisioned" || result.kind === "wristbandReplaced"
                ? "text-warn"
                : "text-danger"
            }`}
          >
            {result.kind === "valid" || result.kind === "recorded" || result.kind === "leadCaptured" ? "✓ " : "✕ "}
            {result.message}
          </p>
          {result.balanceBeforeCents != null && result.balanceAfterCents != null && result.currency && (
            <div className="mt-3 flex items-center justify-center gap-3 text-lg font-bold">
              <span className="text-muted line-through">{formatCents(result.balanceBeforeCents, result.currency)}</span>
              <span aria-hidden="true">→</span>
              <span>{formatCents(result.balanceAfterCents, result.currency)}</span>
            </div>
          )}
        </div>
      )}
    </div>
    </div>
  );
}
