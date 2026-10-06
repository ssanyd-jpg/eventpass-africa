"use client";

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { db, newLocalId } from "@/lib/db";
import { queueOp } from "@/lib/sync-engine";
import { useAppSession } from "@/lib/use-app-session";
import { formatCents, formatDateTime, formatDate } from "@/lib/format";
import { predictSellOut, forecastEventRevenue, type SellOutStatus } from "@/lib/forecast";
import { detectOrderAnomalies } from "@/lib/anomaly";
import { scoreOrderRisk, type RiskBand } from "@/lib/risk";
import { eventHasEnded } from "@/lib/carry-over";
import BarSeries from "@/components/charts/BarSeries";
import Spinner from "@/components/Spinner";
import TimingSetupSection from "@/components/TimingSetupSection";
import ConferenceSessionsSection from "@/components/ConferenceSessionsSection";
import { hasFeature } from "@/lib/event-modes";
import { sendPostEventMemories } from "./post-event-memory-actions";
import { markWhatsappGroupLinkRevoked } from "./whatsapp-group/actions";
import SoldOutCallout from "@/components/SoldOutCallout";

// Deterministic, not Claude-backed — see forecast.ts's header comment.
const SELL_OUT_PILL: Record<SellOutStatus, string> = {
  SOLD_OUT: "",
  LIKELY: "pill border-warn/40 bg-warn/10 text-warn",
  ON_TRACK: "pill border-ok/40 bg-ok/10 text-ok",
  SLOW: "",
  INSUFFICIENT_DATA: "",
};

// Deterministic, not Claude-backed — see anomaly.ts/risk.ts. LOW renders no
// badge at all, matching this codebase's "only show a pill when something's
// notable" convention (e.g. the pending-sync badge only appears when true).
const RISK_STYLE: Record<RiskBand, string> = {
  LOW: "",
  MEDIUM: "pill border-warn/40 bg-warn/10 text-warn",
  HIGH: "pill border-danger/40 bg-danger/10 text-danger",
};

// Mirrors admin/orders/page.tsx's STATUS_STYLE convention — only shown for
// a status worth flagging; PAID renders no pill (the default, unremarkable
// case), matching RISK_STYLE's own "only show when notable" discipline.
const ORDER_STATUS_STYLE: Record<string, string> = {
  NEEDS_REVIEW: "pill border-danger/40 bg-danger/10 text-danger",
  REFUNDED: "pill border-danger/40 bg-danger/10 text-danger",
  PENDING: "pill border-warn/40 bg-warn/10 text-warn",
  PAYMENT_FAILED: "pill border-danger/40 bg-danger/10 text-danger",
  CANCELLED: "pill",
};
const ORDER_STATUS_LABEL: Record<string, string> = {
  NEEDS_REVIEW: "Review",
  REFUNDED: "Refunded",
  PENDING: "Awaiting payment",
  PAYMENT_FAILED: "Payment failed",
  CANCELLED: "Cancelled by buyer",
};

// Mirrors dashboard/page.tsx's own STATUS_STYLE/STATUS_LABEL/derivation —
// Event.status in the schema is only ever LIVE | CANCELLED (no separate
// DRAFT/PUBLISHED state), so "Ended" is derived the same way carry-over
// eligibility is (eventHasEnded).
const EVENT_STATUS_STYLE: Record<"LIVE" | "ENDED" | "CANCELLED", string> = {
  LIVE: "pill border-ok/40 bg-ok/10 text-ok",
  ENDED: "pill",
  CANCELLED: "pill border-danger/40 bg-danger/10 text-danger",
};
const EVENT_STATUS_LABEL: Record<"LIVE" | "ENDED" | "CANCELLED", string> = {
  LIVE: "Live",
  ENDED: "Ended",
  CANCELLED: "Cancelled",
};
function eventDisplayStatus(event: { status: string; startsAt: string; endsAt?: string | null }): "LIVE" | "ENDED" | "CANCELLED" {
  if (event.status === "CANCELLED") return "CANCELLED";
  return eventHasEnded(event) ? "ENDED" : "LIVE";
}

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

// --- Small inline icon set for the action-card grids below. Same hand-drawn
// stroke-icon convention as src/app/page.tsx's HOW_IT_WORKS/FOR_ORGANISERS
// icons (viewBox 0 0 24 24, currentColor, simple 1-3 path shapes) — no icon
// library in this project, so this stays consistent with the existing
// pattern rather than introducing one.
function ScanIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
      <path strokeLinecap="round" d="M4 8V6a2 2 0 0 1 2-2h2M20 8V6a2 2 0 0 0-2-2h-2M4 16v2a2 2 0 0 0 2 2h2M20 16v2a2 2 0 0 1-2 2h-2" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </svg>
  );
}
function CardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path strokeLinecap="round" d="M3 10h18M7 14h4" />
    </svg>
  );
}
function WristbandIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 8.5c-2 1-3 2.2-3 3.5s1 2.5 3 3.5M17 8.5c2 1 3 2.2 3 3.5s-1 2.5-3 3.5" />
      <rect x="7" y="6.5" width="10" height="11" rx="2.5" />
      <path strokeLinecap="round" d="M10 10.5h4M10 13.5h4" />
    </svg>
  );
}
function PulseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h4l2 6 4-12 2 6h6" />
    </svg>
  );
}
function StopwatchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
      <circle cx="12" cy="13" r="7" />
      <path strokeLinecap="round" d="M12 9.5V13l2.5 1.5M10 2h4M12 5V2" />
    </svg>
  );
}
function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
      <path d="M4 11a8 8 0 0 1 13.9-5.3M20 13a8 8 0 0 1-13.9 5.3" />
      <path d="M18 3v4h-4M6 21v-4h4" />
    </svg>
  );
}
function BadgeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
      <rect x="5" y="4" width="14" height="16" rx="2" />
      <circle cx="12" cy="10" r="2.3" />
      <path strokeLinecap="round" d="M8.5 16.5c0-1.7 1.6-3 3.5-3s3.5 1.3 3.5 3" />
    </svg>
  );
}
function TicketIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v1.5a1.5 1.5 0 0 0 0 3V15a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1.5a1.5 1.5 0 0 0 0-3V9Z" />
      <path strokeLinecap="round" d="M10 7v10" strokeDasharray="1.5 2.5" />
    </svg>
  );
}
function QueueIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-5 w-5">
      <path d="M4 7h11M4 12h16M4 17h8" />
    </svg>
  );
}
function SwapIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
      <path d="M4 8h13l-3-3M20 16H7l3 3" />
    </svg>
  );
}
function UsersIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
      <circle cx="9" cy="9" r="3" />
      <path strokeLinecap="round" d="M3.5 19c.6-3 2.8-5 5.5-5s4.9 2 5.5 5" />
      <circle cx="17" cy="9.5" r="2.4" />
      <path strokeLinecap="round" d="M15.8 14.2c2 .3 3.6 2 4.1 4.3" />
    </svg>
  );
}
function StarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" className="h-5 w-5">
      <path d="M12 3.5 14.4 9l6 .6-4.5 4 1.3 5.9L12 16.6 6.8 19.5l1.3-5.9-4.5-4 6-.6Z" />
    </svg>
  );
}
function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path strokeLinecap="round" d="M4 10h16M8 3v4M16 3v4" />
    </svg>
  );
}
function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" className="h-5 w-5">
      <path d="M4 12.5a7.5 7.5 0 1 1 3.3 6.2L4 20l1.4-3.4A7.4 7.4 0 0 1 4 12.5Z" />
    </svg>
  );
}
function BarsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-5 w-5">
      <path d="M5 19V11M12 19V5M19 19v-7" />
    </svg>
  );
}
function ScaleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
      <path d="M12 3v18M7 21h10M5 7h5M14 7h5" />
      <path d="M5 7l-2.5 5a2.5 2.5 0 0 0 5 0L5 7ZM19 7l-2.5 5a2.5 2.5 0 0 0 5 0L19 7Z" />
    </svg>
  );
}
function ClipboardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <rect x="9" y="2.5" width="6" height="3" rx="1" />
      <path strokeLinecap="round" d="M8.5 11h7M8.5 15h5" />
    </svg>
  );
}
function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
      <path d="M12 4v11M8 11l4 4 4-4M5 18h14" />
    </svg>
  );
}
function PhoneMoneyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
      <rect x="7" y="3" width="10" height="18" rx="2" />
      <path strokeLinecap="round" d="M11 18h2" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.5 11.5a2 2 0 1 1 2.6 1.9c-1 .3-1.6.9-1.6 1.6" />
      <path strokeLinecap="round" d="M11.4 16.7h.1" />
    </svg>
  );
}
function FlagIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
      <path d="M6 21V4" />
      <path d="M6 4h12l-3 3.5L18 11H6" />
    </svg>
  );
}
function AgendaIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path strokeLinecap="round" d="M8 9h8M8 13h5" />
    </svg>
  );
}

function StatCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="card p-5">
      <p className="font-display text-2xl font-extrabold tabular-nums">{value}</p>
      <p className="mt-1 text-xs uppercase tracking-wide text-muted">{label}</p>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div id={typeof children === "string" ? children.toLowerCase().replace(/[^a-z0-9]+/g, "-") : undefined} className="mb-3 mt-10 flex items-center gap-3">
      <h2 className="shrink-0 text-xs font-semibold uppercase tracking-widest text-muted">{children}</h2>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function ActionCard({
  icon: Icon,
  title,
  description,
  href,
  external = false,
}: {
  icon: React.ComponentType;
  title: string;
  description: string;
  href: string;
  external?: boolean;
}) {
  const className =
    "group flex items-start gap-4 rounded-xl border border-border bg-surface p-5 transition-colors hover:border-accent/60";
  const inner = (
    <>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-accent/40 bg-accent-soft text-accent-hover">
        <Icon />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="font-semibold">{title}</span>
          <span
            aria-hidden
            className="shrink-0 text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent-hover"
          >
            →
          </span>
        </span>
        <span className="mt-0.5 block text-sm text-muted">{description}</span>
      </span>
    </>
  );
  // On-page anchors (#ticket-types, #attendees) and direct API downloads
  // (/api/...) use a plain <a> — matching dashboard/page.tsx's own export
  // link convention — rather than next/link's client-side router.
  if (href.startsWith("#") || href.startsWith("/api/")) {
    return (
      <a href={href} className={className}>
        {inner}
      </a>
    );
  }
  return (
    <Link href={href} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined} className={className}>
      {inner}
    </Link>
  );
}

export default function ManageEventPage() {
  const { id: rawId } = useParams<{ id: string }>();
  const id = decodeURIComponent(rawId);
  const router = useRouter();
  const { user } = useAppSession();
  const [refunding, setRefunding] = useState<string | null>(null);
  const [refundError, setRefundError] = useState<string | null>(null);
  const [markingPaid, setMarkingPaid] = useState<string | null>(null);

  // Post-event WhatsApp memory recap — status comes from the live DB (not
  // the offline Dexie cache, which has no NotificationLog/attendee-phone
  // data), same "small fetch alongside the mostly-offline page" pattern the
  // reconciliation warning in cancelEvent already uses below.
  const [memoryStatus, setMemoryStatus] = useState<{
    eligible: boolean;
    alreadySent: boolean;
    eligibleAttendeeCount: number;
  } | null>(null);
  const [sendingMemories, setSendingMemories] = useState(false);
  const [memoriesSentCount, setMemoriesSentCount] = useState<number | null>(null);

  // WhatsApp group "revoke your invite link" reminder banner — same small
  // live-DB fetch alongside the Dexie cache as the post-event memory status
  // above, since whatsappGroupLinkRevokedAt/whatsappGroupEnabled aren't
  // synced onto LocalEvent (see shapeEvent's own explicit field list).
  const [showRevokeBanner, setShowRevokeBanner] = useState(false);
  const [revokeBannerDismissed, setRevokeBannerDismissed] = useState(false);
  const [revoking, setRevoking] = useState(false);

  // Middleware already redirects GATE_CREW away from this route server-side
  // — this is defense-in-depth for a device offline with an already-cached
  // page shell (see src/middleware.ts).
  useEffect(() => {
    if (user?.organizationRole === "GATE_CREW") router.replace("/dashboard");
  }, [user, router]);

  useEffect(() => {
    if (!id || user?.organizationRole === "GATE_CREW") return;
    fetch(`/api/dashboard/events/${id}/post-event-memory`, { cache: "no-store" })
      .then((res) => res.json())
      .then((body) => {
        if (body.ok) setMemoryStatus(body);
      })
      .catch(() => {});
  }, [id, user]);

  useEffect(() => {
    if (!id || user?.organizationRole === "GATE_CREW") return;
    fetch(`/api/dashboard/events/${id}/whatsapp-group`, { cache: "no-store" })
      .then((res) => res.json())
      .then((body) => {
        if (body.ok) setShowRevokeBanner(body.showRevokeBanner);
      })
      .catch(() => {});
  }, [id, user]);

  const event = useLiveQuery(async () => {
    const byId = await db.events.get(id);
    return byId ?? (await db.events.where("clientId").equals(id).first()) ?? null;
  }, [id]);

  const orders = useLiveQuery(async () => {
    if (!event) return [];
    const all = await db.orders.where("eventId").equals(event.id).toArray();
    return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }, [event?.id]);

  // Cashless (wristband) sales volume for this event — a wallet SALE is a
  // vendor purchase tapped against a topped-up wristband, separate from
  // ticket revenue in `orders`. Same filter (type SALE, status COMPLETED)
  // as dashboard/page.tsx's own cashlessByEvent, scoped directly to this
  // event via the indexed eventId field instead of scanning every org wallet.
  const wallets = useLiveQuery(async () => {
    if (!event) return [];
    return db.wallets.where("eventId").equals(event.id).toArray();
  }, [event?.id]);

  const walletTransactions = useLiveQuery(async () => {
    if (!wallets || wallets.length === 0) return [];
    const walletIds = new Set(wallets.map((w) => w.id));
    const all = await db.walletTransactions.where("type").equals("SALE").toArray();
    return all.filter((t) => t.status === "COMPLETED" && walletIds.has(t.walletId));
  }, [wallets]);

  if (user?.organizationRole === "GATE_CREW") return null;

  if (event === undefined) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-3 px-4 py-16 text-center text-muted">
        <Spinner />
        <span>Loading…</span>
      </div>
    );
  }

  if (!event) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-16 text-center">
        <p className="font-semibold">Event not found on this device.</p>
        <Link href="/dashboard" className="btn-secondary mt-6 inline-flex">Back to dashboard</Link>
      </div>
    );
  }

  // Allowlist, not an exclusion list — a still-PENDING (unpaid) or
  // PAYMENT_FAILED order isn't real revenue/attendance yet, same reasoning
  // as the REFUNDED exclusion this already had. NEEDS_REVIEW stays counted
  // — pre-existing, unrelated oversell-review behavior.
  const activeOrders = (orders ?? []).filter((o) => o.status === "PAID" || o.status === "NEEDS_REVIEW");
  const tickets = activeOrders.flatMap((o) => o.tickets);
  const checkedInTodayCount = tickets.filter((t) => t.checkedIn && t.checkedInAt && isToday(t.checkedInAt)).length;
  const quantitySoldTotal = event.ticketTypes.reduce((s, tt) => s + tt.quantitySold, 0);
  const quantityTotalSum = event.ticketTypes.reduce((s, tt) => s + tt.quantityTotal, 0);
  const grossRevenueCents = activeOrders.reduce((s, o) => s + o.totalCents, 0);
  const cashlessVolumeCents = (walletTransactions ?? []).reduce((s, t) => s + (t.amountCents ?? 0), 0);
  const displayStatus = eventDisplayStatus(event);

  // Sell-out predictions and revenue forecast — deterministic heuristics
  // computed client-side from the already-synced orders/ticket types this
  // page loads anyway (no new fetch). See forecast.ts.
  const sellOutPredictions = event
    ? event.ticketTypes.map((tt) => {
        const items = activeOrders.flatMap((o) =>
          o.items.filter((i) => i.ticketTypeId === tt.id).map((i) => ({ createdAt: new Date(o.createdAt), quantity: i.quantity }))
        );
        return predictSellOut(tt, items, new Date(event.startsAt));
      })
    : [];

  const revenueForecast = event
    ? forecastEventRevenue(
        activeOrders.map((o) => ({ createdAt: new Date(o.createdAt), totalCents: o.totalCents })),
        new Date(event.startsAt),
        new Date(),
        (cents) => formatCents(cents, event.currency)
      )
    : [];

  // Anomaly flags + risk scores — deterministic, computed over EVERY order
  // for this event including REFUNDED ones (refund-rate is one of the
  // signals, so filtering those out first would blind that signal
  // entirely). See anomaly.ts/risk.ts.
  const anomalyRows = (orders ?? []).map((o) => ({
    id: o.id,
    userId: o.userId,
    userCreatedAt: o.userCreatedAt,
    status: o.status,
    discountCode: o.discountCode ?? null,
    createdAt: o.createdAt,
    ticketCount: o.tickets.length,
    eventId: event?.id ?? "",
  }));
  const orderAnomalies = detectOrderAnomalies(anomalyRows);
  const anomaliesByOrderId = new Map<string, string[]>();
  for (const flag of orderAnomalies) {
    anomaliesByOrderId.set(flag.relatedId, [...(anomaliesByOrderId.get(flag.relatedId) ?? []), flag.message]);
  }
  const riskByOrderId = new Map(anomalyRows.map((row) => [row.id, scoreOrderRisk(row, { allOrders: anomalyRows })]));

  // Likely-abandoned Airpay STK pushes — the buyer's phone prompt expired
  // or they never saw it, but the poll/webhook never resolved it either.
  // Keyed off updatedAt (falls back to createdAt for a not-yet-synced local
  // echo that has no updatedAt yet) rather than createdAt alone, since a
  // resolved-then-somehow-reopened order shouldn't count from its original
  // creation time. 10 minutes is deliberately well past Airpay's own STK
  // prompt timeout (~60-120s in practice) — this is for orders the normal
  // flow has already given up on, not ones still genuinely in flight.
  const TEN_MINUTES_MS = 10 * 60 * 1000;
  const stuckPendingOrders = (orders ?? []).filter(
    (o) => o.status === "PENDING" && Date.now() - new Date(o.updatedAt ?? o.createdAt).getTime() > TEN_MINUTES_MS
  );

  async function markOrderPaid(order: NonNullable<typeof orders>[number]) {
    setMarkingPaid(order.id);
    try {
      // No inventory change — PENDING already reserved it at checkout time.
      await db.orders.put({ ...order, status: "PAID", syncStatus: "pending" });
      await queueOp("MARK_ORDER_PAID", {
        clientId: newLocalId(),
        orderId: order.id,
        orderClientId: order.clientId,
      });
    } finally {
      setMarkingPaid(null);
    }
  }

  async function refundOrder(order: NonNullable<typeof orders>[number]) {
    setRefundError(null);
    setRefunding(order.id);
    try {
      await db.orders.put({ ...order, status: "REFUNDED", syncStatus: "pending" });
      for (const item of order.items) {
        const tt = event!.ticketTypes.find((t) => t.id === item.ticketTypeId);
        if (tt) {
          await db.events.put({
            ...event!,
            ticketTypes: event!.ticketTypes.map((t) =>
              t.id === tt.id ? { ...t, quantitySold: Math.max(0, t.quantitySold - item.quantity) } : t
            ),
          });
        }
      }
      await queueOp("REFUND_ORDER", {
        clientId: newLocalId(),
        orderId: order.id,
        orderClientId: order.clientId,
      });
    } finally {
      setRefunding(null);
    }
  }

  async function onSendMemories() {
    setSendingMemories(true);
    try {
      const result = await sendPostEventMemories(event!.id);
      setMemoriesSentCount(result.notifiedCount);
      setMemoryStatus((prev) => (prev ? { ...prev, alreadySent: true } : prev));
    } finally {
      setSendingMemories(false);
    }
  }

  async function onRevokeLink() {
    setRevoking(true);
    try {
      await markWhatsappGroupLinkRevoked(event!.id);
      setRevokeBannerDismissed(true);
    } finally {
      setRevoking(false);
    }
  }

  async function cancelEvent() {
    // Session 9: warn if cash operators still have unreconciled floats.
    // Best-effort — a failed/offline check never blocks cancellation, it
    // just falls through to the normal confirm.
    try {
      const res = await fetch(`/api/dashboard/events/${event!.id}/reconciliation`, { cache: "no-store" });
      const body = await res.json();
      if (body.ok && body.unreconciledOperatorCount > 0) {
        const n = body.unreconciledOperatorCount;
        if (
          !confirm(
            `${n} cash ${n === 1 ? "operator has" : "operators have"} not been reconciled — reconcile before closing?\n\nOK to cancel the event anyway, or Cancel to go reconcile first.`
          )
        ) {
          return;
        }
      }
    } catch {
      // ignore — proceed to the normal confirm below
    }
    if (!confirm(`Cancel "${event!.title}"? Ticket holders will be notified. This cannot be undone.`)) return;
    await db.events.put({ ...event!, status: "CANCELLED", syncStatus: "pending" });
    await queueOp("CANCEL_EVENT", { eventId: event!.id, eventClientId: event!.clientId });
  }

  const isMarathon = hasFeature(event.eventType, "chipTiming");
  const isConference = hasFeature(event.eventType, "sessionCheckIn");

  return (
    <div className="mx-auto max-w-6xl px-4 pb-20 pt-8 sm:px-6">
      <Link href="/dashboard" className="text-sm text-muted hover:text-foreground">← Dashboard</Link>

      {/* 1. Page header — name, date/venue/status, single primary action. */}
      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-extrabold tracking-tight">{event.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted">
            <span>{formatDateTime(event.startsAt)}</span>
            <span aria-hidden>·</span>
            <span>{event.venue}, {event.city}</span>
            <span className={EVENT_STATUS_STYLE[displayStatus]}>{EVENT_STATUS_LABEL[displayStatus]}</span>
          </div>
        </div>
        <Link href={`/dashboard/events/${event.id}/edit`} className="btn-primary shrink-0">Edit event</Link>
      </div>

      {showRevokeBanner && !revokeBannerDismissed && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn">
          <span>
            ⚠️ Remember to revoke your WhatsApp group invite link to prevent new people joining after the event. Open
            WhatsApp → tap the group name → Invite via link → Revoke link.
          </span>
          <button
            type="button"
            className="shrink-0 font-medium underline disabled:opacity-50"
            disabled={revoking}
            onClick={onRevokeLink}
          >
            {revoking ? "Saving…" : "I've revoked it"}
          </button>
        </div>
      )}

      {memoryStatus && (memoryStatus.eligible || memoryStatus.alreadySent) && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent/30 bg-accent-soft px-4 py-3 text-sm">
          <span>
            {memoriesSentCount !== null
              ? `Memories sent to ${memoriesSentCount} attendee${memoriesSentCount === 1 ? "" : "s"}.`
              : memoryStatus.alreadySent
                ? "Post-event memories already sent."
                : `Send a WhatsApp recap to ${memoryStatus.eligibleAttendeeCount} attendee${memoryStatus.eligibleAttendeeCount === 1 ? "" : "s"} who opted in.`}
          </span>
          {!memoryStatus.alreadySent && memoriesSentCount === null && (
            <button
              onClick={onSendMemories}
              disabled={sendingMemories}
              className="shrink-0 font-medium underline disabled:opacity-50"
            >
              {sendingMemories ? "Sending…" : "Send post-event memories"}
            </button>
          )}
        </div>
      )}

      {/* 2. Key stats row */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Tickets sold" value={`${quantitySoldTotal} / ${quantityTotalSum}`} />
        <StatCard label="Revenue" value={formatCents(grossRevenueCents, event.currency)} />
        <StatCard label="Cashless volume" value={formatCents(cashlessVolumeCents, event.currency)} />
        <StatCard label="Check-ins today" value={checkedInTodayCount} />
      </div>

      {/* 3. Event operations */}
      <SectionLabel>Event operations</SectionLabel>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <ActionCard icon={ScanIcon} title="Gate scanner" description="Scan tickets and check attendees in at the gate." href={`/scan/${event.id}`} />
        <ActionCard icon={CardIcon} title="Vendor terminal" description="Charge wristbands for cashless purchases on-site." href={`/scan/${event.id}/wallet`} />
        <ActionCard icon={WristbandIcon} title="Wristband desk" description="Issue and link NFC wristbands to arriving attendees." href={`/scan/${event.id}/provision`} external />
        <ActionCard icon={PulseIcon} title="Live monitoring" description="Watch sales, check-ins, and vendor activity update live." href={`/dashboard/events/${event.id}/live`} external />
        {isMarathon && (
          <ActionCard icon={StopwatchIcon} title="Timing scanner" description="Scan chip times at checkpoints along the course." href={`/scan/${event.id}/timing`} external />
        )}
        <ActionCard icon={RefreshIcon} title="Wristband replacement" description="Reissue a wristband for a lost or faulty tag." href={`/scan/${event.id}/replace`} external />
        {isConference && (
          <ActionCard icon={BadgeIcon} title="Session scanner" description="Check attendees into individual conference sessions." href={`/scan/${event.id}/session`} external />
        )}
      </div>

      {/* 4. Manage */}
      <SectionLabel>Manage</SectionLabel>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <ActionCard icon={TicketIcon} title="Tickets" description="View and manage ticket types, pricing, and inventory." href="#ticket-types" />
        <ActionCard icon={QueueIcon} title="Waitlist" description="See who's waiting for a ticket type that's sold out." href={`/dashboard/events/${event.id}/waitlist`} />
        <ActionCard icon={SwapIcon} title="Resale" description="Manage attendee-to-attendee ticket resale listings." href={`/dashboard/events/${event.id}/resale`} />
        <ActionCard icon={UsersIcon} title="Volunteers" description="Recruit, schedule, and check in event-day volunteers." href={`/dashboard/events/${event.id}/volunteers`} />
        <ActionCard icon={StarIcon} title="Sponsors" description="Manage sponsor packages, booths, and lead capture." href={`/dashboard/events/${event.id}/sponsors`} />
        <ActionCard icon={CalendarIcon} title="Season passes" description="Manage multi-event passes across your organisation." href="/dashboard/season-passes" />
        <ActionCard icon={ChatIcon} title="WhatsApp group" description="Share the attendee WhatsApp group invite link." href={`/dashboard/events/${event.id}/whatsapp-group`} />
      </div>

      {/* 5. Analytics & reports */}
      <SectionLabel>Analytics &amp; reports</SectionLabel>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <ActionCard icon={BarsIcon} title="Revenue report" description="Track revenue pace and sell-out forecasts." href={`/dashboard/events/${event.id}/forecast`} />
        <ActionCard icon={ScaleIcon} title="Cashless reconciliation" description="Reconcile cash collected by wristband top-up operators." href={`/dashboard/events/${event.id}/reconciliation`} />
        <ActionCard icon={ClipboardIcon} title="Attendee list" description="View every order and ticket holder for this event." href="#attendees" />
        <ActionCard icon={DownloadIcon} title="Export data" description="Download your organisation's sales data as CSV." href="/api/dashboard/analytics/export" />
        {user?.organizationRole === "OWNER" && (
          <ActionCard icon={PhoneMoneyIcon} title="AirPay reconciliation" description="Reconcile mobile money and card payments processed through AirPay." href={`/dashboard/events/${event.id}/airpay-reconciliation`} />
        )}
        {isMarathon && (
          <ActionCard icon={FlagIcon} title="Timing dashboard" description="View chip-timing splits and race results." href={`/dashboard/events/${event.id}/timing`} />
        )}
        {isConference && (
          <ActionCard icon={AgendaIcon} title="Sessions dashboard" description="View attendance and check-in stats per conference session." href={`/dashboard/events/${event.id}/sessions`} />
        )}
      </div>

      {isMarathon && (
        <TimingSetupSection eventId={event.id} eventTitle={event.title} eventType={event.eventType} gunStartAt={event.gunStartAt} />
      )}

      {isConference && <ConferenceSessionsSection eventId={event.id} />}

      <SectionLabel>Ticket types</SectionLabel>
      <div className="card divide-y divide-border">
        {event.ticketTypes.map((tt) => {
          const prediction = sellOutPredictions.find((p) => p.ticketTypeId === tt.id);
          return (
            <div key={tt.id} className="flex items-center justify-between p-4">
              <div>
                <p className="font-medium">{tt.name}</p>
                <p className="text-sm text-muted">{formatCents(tt.priceCents, event.currency)} each</p>
              </div>
              <div className="text-right text-sm">
                <p>
                  <span className="font-semibold">{tt.quantitySold}</span>
                  <span className="text-muted"> / {tt.quantityTotal} sold</span>
                  {tt.quantitySold > tt.quantityTotal && (
                    <span className="ml-2 pill border-danger/40 bg-danger/10 text-danger">Oversold</span>
                  )}
                </p>
                {prediction?.status === "LIKELY" && prediction.predictedSoldOutDate && (
                  <p className="mt-1">
                    <span className={SELL_OUT_PILL.LIKELY}>Likely to sell out {formatDate(prediction.predictedSoldOutDate)}</span>
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Page already returns null for GATE_CREW above (plus the
          middleware redirect) — anything rendered past that point,
          including this, is already OWNER/STAFF-only. */}
      {event.ticketTypes
        .filter((tt) => tt.quantitySold >= tt.quantityTotal)
        .map((tt) => (
          <SoldOutCallout key={tt.id} eventId={event.id} ticketTypeId={tt.id} ticketTypeName={tt.name} />
        ))}

      {revenueForecast.length > 0 && (
        <>
          <SectionLabel>Revenue trend</SectionLabel>
          <div className="card p-5">
            <BarSeries data={revenueForecast} emptyLabel="No sales yet." />
            {revenueForecast.some((p) => p.projected) && (
              <p className="mt-3 text-xs text-muted">Lighter bars are a projection based on recent sales pace, not actual revenue.</p>
            )}
          </div>
        </>
      )}

      {stuckPendingOrders.length > 0 && (
        <>
          <SectionLabel>Pending payments needing follow-up</SectionLabel>
          <div className="card divide-y divide-border">
            {stuckPendingOrders.map((order) => {
              const minutesPending = Math.floor(
                (Date.now() - new Date(order.updatedAt ?? order.createdAt).getTime()) / 60000
              );
              return (
                <div key={order.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                  <div>
                    <p className="font-medium">{formatCents(order.totalCents, order.currency)}</p>
                    <p className="text-xs text-muted">
                      {order.items.map((i) => `${i.quantity}× ${i.ticketTypeName}`).join(", ")}
                    </p>
                    <p className="mt-1 text-xs text-warn">
                      Pending {minutesPending}m{order.providerReference ? ` · Ref: ${order.providerReference}` : ""}
                    </p>
                  </div>
                  <button
                    onClick={() => markOrderPaid(order)}
                    disabled={markingPaid === order.id}
                    className="btn-secondary !py-1.5 text-xs disabled:opacity-50"
                  >
                    {markingPaid === order.id ? "Marking…" : "Mark as paid"}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}

      <SectionLabel>Attendees</SectionLabel>
      {refundError && <p className="mb-3 text-sm text-danger">{refundError}</p>}
      {(orders ?? []).length === 0 ? (
        <div className="card p-8 text-center text-muted">No tickets sold yet.</div>
      ) : (
        <div className="card divide-y divide-border">
          {(orders ?? []).map((order) => (
            <div key={order.id} className="p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{formatCents(order.totalCents, event.currency)}</span>
                  <span className="text-muted">
                    {order.tickets.map((t) => t.code).join(", ")}
                  </span>
                  {order.syncStatus === "pending" && (
                    <span className="pill border-warn/40 bg-warn/10 text-warn">Pending sync</span>
                  )}
                  {ORDER_STATUS_STYLE[order.status] && (
                    <span className={ORDER_STATUS_STYLE[order.status]}>{ORDER_STATUS_LABEL[order.status]}</span>
                  )}
                  {order.paymentMethod === "OFFLINE_DEFERRED" && (
                    <span className="pill">Offline</span>
                  )}
                  {(() => {
                    const risk = riskByOrderId.get(order.id);
                    if (!risk || risk.band === "LOW") return null;
                    return (
                      <span className={RISK_STYLE[risk.band]} title={(anomaliesByOrderId.get(order.id) ?? risk.reasons).join("; ")}>
                        Risk: {risk.band.toLowerCase()}
                      </span>
                    );
                  })()}
                </div>
                {(order.status === "PAID" || order.status === "NEEDS_REVIEW") && (
                  <button
                    onClick={() => refundOrder(order)}
                    disabled={refunding === order.id}
                    className="text-xs font-medium text-danger hover:underline disabled:opacity-50"
                  >
                    {refunding === order.id ? "Refunding…" : "Refund"}
                  </button>
                )}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                {order.tickets.map((t) => (
                  <span key={t.id}>
                    {t.ticketTypeName} — {t.checkedIn ? "checked in" : "not yet"}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 6. Danger zone */}
      {event.status !== "CANCELLED" && (
        <>
          <SectionLabel>Danger zone</SectionLabel>
          <div className="card border-danger/30 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold">Cancel this event</p>
                <p className="mt-0.5 text-sm text-muted">Ticket holders will be notified. This cannot be undone.</p>
              </div>
              <button
                onClick={cancelEvent}
                className="shrink-0 rounded-full border border-danger/40 bg-danger/10 px-5 py-2.5 text-sm font-semibold text-danger transition hover:bg-danger/20"
              >
                Cancel event
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
