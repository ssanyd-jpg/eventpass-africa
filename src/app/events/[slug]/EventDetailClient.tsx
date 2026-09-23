"use client";

import { Suspense, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { db, newLocalId, type LocalTicketType } from "@/lib/db";
import { queueOp, useOnlineStatus } from "@/lib/sync-engine";
import { useAppSession } from "@/lib/use-app-session";
import { useTranslation } from "@/lib/use-translation";
import { formatCents, formatDateTime, generateTicketCode } from "@/lib/format";
import QuestionFields from "@/components/QuestionFields";
import Spinner from "@/components/Spinner";
import { useSwipeBack } from "@/lib/use-swipe-gesture";

// Session 27 — a client-safe copy of the same resolution rule as
// currentPriceCents/nextTierInfo in src/lib/pricing.ts. Duplicated rather
// than imported: that module also exports a Prisma-backed getCurrentPrice,
// and importing it here would pull @/lib/prisma into the browser bundle.
// Same "client computes an optimistic estimate, server is authoritative"
// tradeoff this component already makes for discount codes.
function currentTierPriceCents(tt: LocalTicketType): number {
  if (tt.pricingStrategy !== "TIERED" || tt.pricingTiers.length === 0) return tt.priceCents;
  const reached = tt.pricingTiers
    .filter((t) => tt.quantitySold >= t.fromQuantity)
    .sort((a, b) => b.fromQuantity - a.fromQuantity);
  return reached.length > 0 ? reached[0].priceCents : tt.priceCents;
}

function nextTierFor(tt: LocalTicketType): { priceCents: number; atQuantity: number } | null {
  if (tt.pricingStrategy !== "TIERED" || tt.pricingTiers.length === 0) return null;
  const upcoming = tt.pricingTiers
    .filter((t) => tt.quantitySold < t.fromQuantity)
    .sort((a, b) => a.fromQuantity - b.fromQuantity);
  return upcoming.length > 0 ? { priceCents: upcoming[0].priceCents, atQuantity: upcoming[0].fromQuantity } : null;
}

const NETWORKS = [
  { value: "MPESA", label: "M-Pesa" },
  { value: "TIGO", label: "Tigo Pesa" },
  { value: "AIRTEL", label: "Airtel Money" },
  { value: "HALOTEL", label: "HaloPesa" },
];

const CHECKOUT_STEPS = [
  { key: "select", label: "Select" },
  { key: "questions", label: "Details" },
  { key: "confirm", label: "Pay" },
] as const;

// Purely visual — the "questions" step is skipped entirely in the flow when
// an event has no registration questions/waiver (see hasQuestionsStep), but
// the indicator still shows all three dots for a consistent "3 steps" shape
// rather than reflowing to 2.
function CheckoutStepIndicator({ step }: { step: "select" | "questions" | "confirm" }) {
  const currentIndex = CHECKOUT_STEPS.findIndex((s) => s.key === step);
  return (
    <div className="mb-5 flex items-center" aria-label="Checkout progress">
      {CHECKOUT_STEPS.map((s, i) => {
        const isDone = i < currentIndex;
        const isActive = i === currentIndex;
        return (
          <div key={s.key} className="flex flex-1 items-center last:flex-none">
            <div className="flex flex-col items-center gap-1">
              <div
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold transition ${
                  isDone
                    ? "bg-accent text-white"
                    : isActive
                      ? "border-2 border-accent text-accent-hover"
                      : "border border-border text-muted"
                }`}
              >
                {isDone ? "✓" : i + 1}
              </div>
              <span className={`text-[11px] font-medium ${isActive ? "text-foreground" : "text-muted"}`}>
                {s.label}
              </span>
            </div>
            {i < CHECKOUT_STEPS.length - 1 && (
              <div className={`mx-2 h-px flex-1 ${isDone ? "bg-accent" : "bg-border"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// useSearchParams (for the waitlist purchase-link's ?waitlistEntryId=) needs
// a Suspense boundary around its caller — same wrapping login/page.tsx uses.
export default function EventDetailClient() {
  return (
    <Suspense fallback={null}>
      <EventDetailContent />
    </Suspense>
  );
}

function EventDetailContent() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAppSession();
  const online = useOnlineStatus();
  const { t } = useTranslation();
  const events = useLiveQuery(() => db.events.toArray(), []);
  const event = events?.find((e) => e.slug === slug);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  // A "Buy your ticket now" link from a NOTIFIED waitlist entry
  // (/waitlist/[entryId]) carries this so the completed purchase can mark
  // that entry CONVERTED server-side — see handleSellTickets.
  const waitlistEntryId = searchParams.get("waitlistEntryId");

  // Session 26 — sold-out waitlist signup, keyed per ticket type since
  // several tiers on the same event can independently be sold out.
  const [waitlistFormFor, setWaitlistFormFor] = useState<string | null>(null);
  const [waitlistName, setWaitlistName] = useState("");
  const [waitlistPhone, setWaitlistPhone] = useState("");
  const [waitlistEmail, setWaitlistEmail] = useState("");
  const [waitlistSubmitting, setWaitlistSubmitting] = useState(false);
  const [waitlistError, setWaitlistError] = useState<string | null>(null);

  async function joinWaitlist(ticketTypeId: string) {
    if (!waitlistName.trim() || !waitlistPhone.trim()) {
      setWaitlistError("Enter your name and phone number.");
      return;
    }
    setWaitlistSubmitting(true);
    setWaitlistError(null);
    const res = await fetch(`/api/events/${slug}/waitlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ticketTypeId,
        name: waitlistName.trim(),
        phone: waitlistPhone.trim(),
        email: waitlistEmail.trim() || undefined,
      }),
    });
    setWaitlistSubmitting(false);
    if (!res.ok) {
      setWaitlistError("Couldn't join the waitlist. Try again.");
      return;
    }
    const data = await res.json();
    router.push(`/waitlist/${data.entryId}`);
  }
  const [step, setStep] = useState<"select" | "questions" | "confirm">("select");
  const [placing, setPlacing] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [waiverAccepted, setWaiverAccepted] = useState(false);
  const [discountCode, setDiscountCode] = useState("");
  const [phone, setPhone] = useState("");
  const [network, setNetwork] = useState(NETWORKS[0].value);

  // Session 13 — group/family checkout. One name per ticket being bought,
  // in the same order tickets get flattened below — kept in sync with
  // totalQty as the buyer adjusts quantities, preserving names already
  // typed for the tickets that are still there.
  const [isGroup, setIsGroup] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [memberNames, setMemberNames] = useState<string[]>([]);

  const selection = useMemo(() => {
    if (!event) return [];
    return event.ticketTypes
      .map((tt) => ({ tt, qty: quantities[tt.id] ?? 0 }))
      .filter((s) => s.qty > 0);
  }, [event, quantities]);

  const totalCents = selection.reduce((sum, s) => sum + currentTierPriceCents(s.tt) * s.qty, 0);
  const totalQty = selection.reduce((sum, s) => sum + s.qty, 0);

  // Padded/truncated to the current totalQty for rendering and validation —
  // memberNames itself only grows via setMemberName, so a quantity change
  // (up or down) is reflected here without a separate effect to keep it in
  // sync.
  const displayedMemberNames = Array.from({ length: totalQty }, (_, i) => memberNames[i] ?? "");
  function setMemberName(index: number, name: string) {
    const next = displayedMemberNames.slice();
    next[index] = name;
    setMemberNames(next);
  }
  const groupReady = !isGroup || (groupName.trim().length > 0 && displayedMemberNames.every((n) => n.trim().length > 0));

  // Skip the questions step entirely when there's nothing to ask — no empty
  // screen between selecting tickets and confirming.
  const registrationQuestions = event?.registrationQuestions ?? [];
  const hasQuestionsStep = registrationQuestions.length > 0 || !!event?.waiverText;
  const answersValid = registrationQuestions.every((q) => !q.required || (answers[q.id] ?? "").trim());
  const waiverOk = !event?.waiverText || waiverAccepted;

  // Session E — edge-swipe to go back a checkout step (spec item 4), the
  // same gesture the "Back" buttons on the questions/confirm steps already
  // perform. Only armed past the first step — on "select" there's nothing
  // to swipe back to within this flow, and it stays as ordinary page
  // navigation there.
  useSwipeBack(() => {
    if (step === "questions") setStep("select");
    else if (step === "confirm") setStep(hasQuestionsStep ? "questions" : "select");
  }, step !== "select");

  if (events === undefined) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-3 px-4 py-16 text-center text-muted">
        <Spinner />
        <span>{t("common.loading")}</span>
      </div>
    );
  }

  if (!event) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-16 text-center">
        <p className="text-lg font-semibold">{t("common.eventNotFound")}</p>
        <p className="mt-2 text-sm text-muted">
          {t("event.notFoundHint")}
        </p>
        <Link href="/" className="btn-secondary mt-6 inline-flex">{t("common.backToBrowse")}</Link>
      </div>
    );
  }

  function setQty(ticketTypeId: string, qty: number, max: number) {
    setQuantities((q) => ({ ...q, [ticketTypeId]: Math.max(0, Math.min(qty, max)) }));
  }

  async function placeOrder() {
    if (!event || event.status === "CANCELLED") return;
    if (!user) {
      router.push(`/login?callbackUrl=/events/${slug}`);
      return;
    }
    setPlacing(true);

    const clientId = newLocalId();
    // Session 13 — when buying for a group, memberNames maps 1:1 onto
    // these tickets in this exact flattened order (items are sent to
    // SELL_TICKETS in the same order below, and the server expands each
    // item by quantity the same way — see handleSellTickets).
    let memberIndex = 0;
    const tickets = selection.flatMap((s) =>
      Array.from({ length: s.qty }).map(() => ({
        id: newLocalId(),
        clientId: newLocalId(),
        code: generateTicketCode(),
        ticketTypeId: s.tt.id,
        ticketTypeName: s.tt.name,
        checkedIn: false,
        checkedInAt: null,
        groupMemberName: isGroup ? displayedMemberNames[memberIndex++]?.trim() || null : null,
      }))
    );

    const order = {
      id: clientId,
      clientId,
      // Online buyers hold in PENDING until the Airpay STK push confirms
      // (see handleSellTickets/handleCheckOrderPaymentStatus); offline
      // buyers keep the original instant-PAID flow, deferred to organizer
      // reconciliation via paymentMethod below.
      status: online ? "PENDING" : "PAID",
      totalCents,
      currency: event.currency,
      createdAt: new Date().toISOString(),
      userId: user.id,
      eventId: event.id,
      eventClientId: event.clientId,
      eventTitle: event.title,
      items: selection.map((s) => ({
        ticketTypeId: s.tt.id,
        ticketTypeName: s.tt.name,
        quantity: s.qty,
        unitPriceCents: currentTierPriceCents(s.tt),
      })),
      tickets,
      waiverText: event.waiverText ?? null,
      waiverAcceptedAt: waiverAccepted ? new Date().toISOString() : null,
      answers: registrationQuestions.map((q) => ({
        questionId: q.id,
        questionLabel: q.label,
        value: answers[q.id] ?? "",
      })),
      // Discounts can't be pre-validated offline (codes deliberately don't
      // ride in the public event pull) — the optimistic local echo keeps
      // the full list-price total; applySellTicketsResult overwrites this
      // whole order with the server-authoritative, correctly discounted one
      // once sync succeeds.
      syncStatus: "pending" as const,
      paymentMethod: online ? "AIRPAY_ONLINE" : "OFFLINE_DEFERRED",
      providerReference: null,
      providerMessage: online ? "Awaiting payment confirmation on your phone." : "Purchased offline — payment collection deferred.",
    };

    await db.orders.put(order);

    // reflect the sale locally right away so inventory looks correct offline
    await db.events.put({
      ...event,
      ticketTypes: event.ticketTypes.map((tt) => {
        const sold = selection.find((s) => s.tt.id === tt.id);
        return sold ? { ...tt, quantitySold: tt.quantitySold + sold.qty } : tt;
      }),
    });

    await queueOp("SELL_TICKETS", {
      clientId,
      eventId: event.id,
      eventClientId: event.clientId,
      // Codes are generated client-side and already shown to the buyer —
      // the server must reuse these exact codes rather than generating its
      // own, or the code on screen would silently stop matching what's
      // actually valid once this order syncs.
      items: selection.map((s) => ({
        ticketTypeId: s.tt.id,
        quantity: s.qty,
        codes: tickets.filter((t) => t.ticketTypeId === s.tt.id).map((t) => t.code),
      })),
      answers: registrationQuestions.map((q) => ({ questionId: q.id, value: answers[q.id] ?? "" })),
      waiverAccepted,
      discountCode: discountCode.trim() || undefined,
      paymentMethod: online ? "AIRPAY_ONLINE" : "OFFLINE_DEFERRED",
      phoneNumber: online ? phone.trim() : undefined,
      mobileNetwork: online ? network : undefined,
      group: isGroup
        ? { name: groupName.trim(), memberNames: displayedMemberNames.map((n) => n.trim()) }
        : undefined,
      waitlistEntryId: waitlistEntryId ?? undefined,
    });

    // /orders/[id] live-queries this exact order out of Dexie, so it picks
    // up the PENDING → PAID/PAYMENT_FAILED transition once the outbox flush
    // resolves — unlike rendering a static snapshot inline here, which
    // would never reflect a payment confirming in the background.
    router.push(`/orders/${clientId}`);
  }

  return (
    <div className="mx-auto max-w-4xl px-4 pb-20 pt-6 sm:px-6">
      <Link href="/" className="text-sm text-muted hover:text-foreground">← {t("common.backToBrowse")}</Link>

      <div className="mt-4 overflow-hidden rounded-2xl border border-border">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={event.imageUrl} alt={event.title} className="h-64 w-full object-cover sm:h-80" />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <div className="mb-3 flex items-center gap-2">
            <span className="pill">{event.category}</span>
            {event.status === "CANCELLED" && (
              <span className="pill border-danger/40 bg-danger/10 text-danger">{t("event.cancelledPill")}</span>
            )}
          </div>
          <h1 className="text-balance text-2xl font-bold sm:text-3xl">{event.title}</h1>
          <p className="mt-2 text-muted">{formatDateTime(event.startsAt)}</p>
          <p className="text-muted">{event.venue} · {event.city}</p>
          <p className="mt-1 text-xs text-muted">{t("event.organizedBy", { name: event.organizerName })}</p>
          <p className="mt-6 whitespace-pre-line leading-relaxed text-foreground/90">
            {event.description}
          </p>

          {event.status === "LIVE" && (
            <Link
              href="/account/wallet"
              className="mt-4 inline-flex text-sm font-medium text-accent-hover"
            >
              {t("event.getWalletLink")}
            </Link>
          )}

          {(event.vendors.length > 0 || (event.vendorApplicationsOpen && new Date(event.startsAt) > new Date())) && (
            <div className="mt-8 border-t border-border pt-6">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-semibold">{t("event.vendorsHeading")}</h2>
                {event.vendorApplicationsOpen && new Date(event.startsAt) > new Date() && (
                  <Link href={`/events/${slug}/vendors/apply`} className="text-sm font-medium text-accent-hover">
                    {t("event.applyAsVendor")}
                  </Link>
                )}
              </div>
              {event.vendors.length === 0 ? (
                <p className="text-sm text-muted">{t("event.noVendorsYet")}</p>
              ) : (
                <ul className="space-y-2">
                  {event.vendors.map((v) => (
                    <li key={v.id} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
                      <span>{v.name}</span>
                      <span className="text-muted">
                        {v.category}{v.boothNumber ? ` · ${t("common.boothNumber", { number: v.boothNumber })}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {event.status === "CANCELLED" ? (
          <div className="card h-fit p-5 lg:sticky lg:top-24 lg:self-start">
            <p className="font-semibold text-danger">{t("event.cancelledCardTitle")}</p>
            <p className="mt-2 text-sm text-muted">
              {t("event.cancelledCardBody")}
            </p>
          </div>
        ) : (
        <div className="card h-fit p-5 lg:sticky lg:top-24 lg:self-start">
          <CheckoutStepIndicator step={step} />
          {step === "select" && (
            <>
              <h2 className="mb-4 font-semibold">{t("event.selectTickets")}</h2>

              <label className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-surface2 p-3 text-sm">
                <input
                  type="checkbox"
                  checked={isGroup}
                  onChange={(e) => setIsGroup(e.target.checked)}
                />
                {t("event.buyingForGroup")}
              </label>
              {isGroup && (
                <div className="mb-4">
                  <label className="label" htmlFor="groupName">{t("event.groupNameLabel")}</label>
                  <input
                    id="groupName"
                    className="input"
                    placeholder={t("event.groupNamePlaceholder")}
                    maxLength={120}
                    value={groupName}
                    onChange={(e) => setGroupName(e.target.value)}
                  />
                  <p className="mt-1 text-xs text-muted">
                    {t("event.groupNameHint")}
                  </p>
                </div>
              )}

              <div className="space-y-4">
                {event.ticketTypes.map((tt) => {
                  const remaining = tt.quantityTotal - tt.quantitySold;
                  const isSoldOut = remaining <= 0;
                  const isLowStock = !isSoldOut && tt.quantityTotal > 0 && remaining / tt.quantityTotal <= 0.2;
                  const qty = quantities[tt.id] ?? 0;
                  const soldOutWithWaitlist = isSoldOut && event.waitlistEnabled;
                  const currentPriceCents = currentTierPriceCents(tt);
                  const nextTier = nextTierFor(tt);
                  return (
                    <div
                      key={tt.id}
                      className={`border-b border-border pb-4 last:border-0 last:pb-0 ${isSoldOut ? "opacity-60" : ""}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="font-medium">{tt.name}</p>
                            {isSoldOut && (
                              <span className="pill border-danger/40 bg-danger/10 !py-0.5 text-[10px] text-danger">
                                {t("event.soldOut")}
                              </span>
                            )}
                            {isLowStock && (
                              <span className="pill border-warn/40 bg-warn/10 !py-0.5 text-[10px] text-warn">
                                Only {remaining} left
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-muted">{formatCents(currentPriceCents, event.currency)}</p>
                          {nextTier && (
                            <p className="text-xs text-accent-hover">
                              Price increases to {formatCents(nextTier.priceCents, event.currency)} after{" "}
                              {nextTier.atQuantity} tickets sold ({tt.quantitySold} sold so far)
                            </p>
                          )}
                          {!isSoldOut && !isLowStock && (
                            <p className="text-xs text-muted">{t("event.leftSuffix", { count: remaining })}</p>
                          )}
                        </div>
                        {!soldOutWithWaitlist && !isSoldOut && (
                          <div className="flex items-center gap-2">
                            <button
                              className="btn-secondary h-8 w-8 !rounded-full !p-0"
                              disabled={qty <= 0}
                              onClick={() => setQty(tt.id, qty - 1, remaining)}
                            >
                              −
                            </button>
                            <span className="w-5 text-center text-sm">{qty}</span>
                            <button
                              className="btn-secondary h-8 w-8 !rounded-full !p-0"
                              disabled={remaining <= 0 || qty >= remaining}
                              onClick={() => setQty(tt.id, qty + 1, remaining)}
                            >
                              +
                            </button>
                          </div>
                        )}
                        {soldOutWithWaitlist && waitlistFormFor !== tt.id && (
                          <button className="btn-secondary shrink-0" onClick={() => setWaitlistFormFor(tt.id)}>
                            Join waitlist
                          </button>
                        )}
                      </div>

                      {soldOutWithWaitlist && waitlistFormFor === tt.id && (
                        <div className="mt-3 space-y-2 rounded-lg border border-border bg-surface2 p-3">
                          <input
                            className="input"
                            placeholder="Your name"
                            value={waitlistName}
                            onChange={(e) => setWaitlistName(e.target.value)}
                          />
                          <input
                            className="input"
                            placeholder="Phone (e.g. 0712 345 678)"
                            value={waitlistPhone}
                            onChange={(e) => setWaitlistPhone(e.target.value)}
                          />
                          <input
                            className="input"
                            placeholder="Email (optional)"
                            value={waitlistEmail}
                            onChange={(e) => setWaitlistEmail(e.target.value)}
                          />
                          {waitlistError && <p className="text-xs text-danger">{waitlistError}</p>}
                          <div className="flex gap-2">
                            <button
                              className="btn-secondary flex-1"
                              onClick={() => {
                                setWaitlistFormFor(null);
                                setWaitlistError(null);
                              }}
                            >
                              Cancel
                            </button>
                            <button
                              className="btn-primary flex-1"
                              disabled={waitlistSubmitting}
                              onClick={() => joinWaitlist(tt.id)}
                            >
                              {waitlistSubmitting ? "Joining…" : "Join waitlist"}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {isGroup && totalQty > 0 && (
                <div className="mt-5 border-t border-border pt-4">
                  <p className="label">{t("event.memberNamesLabel")}</p>
                  <p className="mb-2 text-xs text-muted">{t("event.memberNamesHint")}</p>
                  <div className="space-y-2">
                    {displayedMemberNames.map((name, i) => (
                      <input
                        key={i}
                        className="input"
                        placeholder={t("event.memberNamePlaceholder", { number: i + 1 })}
                        maxLength={80}
                        value={name}
                        onChange={(e) => setMemberName(i, e.target.value)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Sticky on mobile so Total + Continue stay reachable while
                  scrolling a long ticket-type list, without needing a
                  separate fixed-position bar (it un-sticks once the card
                  itself scrolls out of view). Reverts to a plain static
                  block from lg up, where the whole panel is already
                  lg:sticky in the viewport. */}
              <div className="sticky bottom-0 -mx-5 -mb-5 mt-5 border-t border-border bg-surface p-4 lg:static lg:mx-0 lg:mb-0 lg:border-0 lg:bg-transparent lg:p-0">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted">{t("event.total")}</span>
                  <span className="font-semibold">{formatCents(totalCents, event.currency)}</span>
                </div>
                <button
                  className="btn-primary mt-4 w-full"
                  disabled={totalQty === 0 || !groupReady}
                  onClick={() => setStep(hasQuestionsStep ? "questions" : "confirm")}
                >
                  {t("event.continue")}
                </button>
              </div>
            </>
          )}

          {step === "questions" && (
            <>
              <h2 className="mb-4 font-semibold">{t("event.questionsHeading")}</h2>
              <div className="space-y-4">
                <QuestionFields
                  questions={registrationQuestions}
                  answers={answers}
                  onChange={(questionId, value) => setAnswers((a) => ({ ...a, [questionId]: value }))}
                />

                {event.waiverText && (
                  <div className="border-t border-border pt-4">
                    <p className="label">{t("event.waiverLabel")}</p>
                    <div className="max-h-40 overflow-y-auto whitespace-pre-line rounded-lg border border-border bg-surface2 p-3 text-xs text-muted">
                      {event.waiverText}
                    </div>
                    <label className="mt-2 flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={waiverAccepted}
                        onChange={(e) => setWaiverAccepted(e.target.checked)}
                      />
                      {t("event.waiverAccept")}
                    </label>
                  </div>
                )}
              </div>

              <div className="sticky bottom-0 -mx-5 -mb-5 mt-4 flex gap-2 border-t border-border bg-surface p-4 lg:static lg:mx-0 lg:mb-0 lg:border-0 lg:bg-transparent lg:p-0">
                <button className="btn-secondary flex-1" onClick={() => setStep("select")}>
                  {t("event.back")}
                </button>
                <button
                  className="btn-primary flex-1"
                  disabled={!answersValid || !waiverOk}
                  onClick={() => setStep("confirm")}
                >
                  {t("event.continue")}
                </button>
              </div>
            </>
          )}

          {step === "confirm" && (
            <>
              <h2 className="mb-4 font-semibold">{t("event.confirmAndPay")}</h2>
              {isGroup && (
                <div className="mb-4 rounded-lg border border-border bg-surface2 p-3 text-sm">
                  <p className="font-medium">{groupName.trim()}</p>
                  <p className="text-xs text-muted">
                    {t("event.groupWalletHint", { names: displayedMemberNames.join(", ") })}
                  </p>
                </div>
              )}
              <div className="space-y-2 text-sm">
                {selection.map((s) => (
                  <div key={s.tt.id} className="flex justify-between">
                    <span>{s.qty}× {s.tt.name}</span>
                    <span>{formatCents(currentTierPriceCents(s.tt) * s.qty, event.currency)}</span>
                  </div>
                ))}
                <div className="flex justify-between border-t border-border pt-2 font-semibold">
                  <span>{t("event.total")}</span>
                  <span>{formatCents(totalCents, event.currency)}</span>
                </div>
              </div>

              <div className="mt-4">
                <label className="label" htmlFor="discountCode">{t("event.discountCodeLabel")}</label>
                <input
                  id="discountCode"
                  className="input"
                  placeholder={t("event.discountCodePlaceholder")}
                  value={discountCode}
                  onChange={(e) => setDiscountCode(e.target.value)}
                />
                <p className="mt-1 text-xs text-muted">
                  {t("event.discountCodeHint")}
                </p>
              </div>

              {online && (
                <div className="mt-4 space-y-3">
                  <div>
                    <label className="label" htmlFor="network">{t("event.mobileNetworkLabel")}</label>
                    <select id="network" className="input" value={network} onChange={(e) => setNetwork(e.target.value)}>
                      {NETWORKS.map((n) => (
                        <option key={n.value} value={n.value}>{n.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor="phone">{t("event.phoneLabel")}</label>
                    <input
                      id="phone"
                      className="input"
                      placeholder={t("event.phonePlaceholder")}
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                    />
                  </div>
                </div>
              )}

              <div
                className={`mt-4 flex items-start gap-2.5 rounded-lg border p-3 text-xs ${
                  online ? "border-accent/40 bg-accent-soft text-foreground" : "border-border bg-surface2 text-muted"
                }`}
              >
                {online && <span aria-hidden className="mt-0.5 text-base">📲</span>}
                <span>{online ? t("event.onlinePaymentHint") : t("event.offlinePaymentHint")}</span>
              </div>

              {!user && (
                <p className="mt-3 text-xs text-warn">
                  {t("event.loginRequiredHint")}
                </p>
              )}

              {/* Same sticky-while-in-view treatment as the select step's
                  Total/Continue bar — keeps Back/Pay reachable on a long
                  confirm panel (discount code + network + phone fields)
                  without scrolling all the way down on mobile. */}
              <div className="sticky bottom-0 -mx-5 -mb-5 mt-4 flex gap-2 border-t border-border bg-surface p-4 lg:static lg:mx-0 lg:mb-0 lg:border-0 lg:bg-transparent lg:p-0">
                <button className="btn-secondary flex-1" onClick={() => setStep(hasQuestionsStep ? "questions" : "select")}>
                  {t("event.back")}
                </button>
                <button
                  className="btn-primary flex-1"
                  disabled={placing || (online && phone.trim().length < 6)}
                  onClick={placeOrder}
                >
                  {placing ? t("event.placing") : user ? t("event.payAmount", { amount: formatCents(totalCents, event.currency) }) : t("event.loginToPay")}
                </button>
              </div>
            </>
          )}
        </div>
        )}
      </div>
    </div>
  );
}
