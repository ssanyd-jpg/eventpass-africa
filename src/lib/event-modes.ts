import { dictionaries } from "@/lib/i18n";

// Session 22 — single source of truth for what a given eventType unlocks.
// Before this, feature gating was scattered as inline `eventType === "..."`
// checks across the dashboard, vendor portal, wallet terminal, and sync
// handlers (see the call sites this replaces: dashboard/events/[id]/page.tsx,
// vendor/[vendorId]/dashboard/page.tsx, scan/[eventId]/wallet/page.tsx).
// Adding a new event type used to mean hunting down every one of those
// conditionals; now it means adding one entry here.
export const EVENT_TYPES = [
  "GENERAL",
  "MARATHON",
  "CONFERENCE",
  "FOOTBALL",
  "CONCERT",
  "FESTIVAL",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

// SINGLE_ENTRY: a ticket admits once, no re-entry (the common case).
// REENTRY: attendees are expected to leave and come back (e.g. a multi-day
// festival with camping). MULTI_ZONE: admission is checked separately at
// several distinct areas rather than one gate (e.g. a conference's session
// rooms). This is metadata only today — no scanner currently branches on
// it — same "define now, wire up later" posture as multiDayPass/
// stageSchedule below.
export type GateMode = "SINGLE_ENTRY" | "REENTRY" | "MULTI_ZONE";

export interface EventModeConfig {
  label: string;
  labelSw: string;
  defaultGateMode: GateMode;
  // Marathon-only today: unlocks the timing setup section, the timing
  // scanner, and gunStartAt on the event dashboard.
  chipTiming: boolean;
  // Tracks chipTiming today (both come from the same "Marathon" unlock) —
  // kept as its own flag since the public leaderboard is a distinct surface
  // (/events/[slug]/leaderboard) that a later session may want to unlock
  // independently of timing setup.
  publicLeaderboard: boolean;
  // Conference-only today: unlocks session setup, the session scanner, and
  // ConferenceSessionsSection on the event dashboard.
  sessionCheckIn: boolean;
  // Conference-only today: unlocks exhibitor lead-capture mode on the
  // wallet terminal and the vendor portal's "My leads" section.
  exhibitorLeads: boolean;
  // NOT currently gated by eventType in the codebase — any ticket type can
  // opt into fast-track via TicketType.isFastTrack or a "VIP" name (see
  // isFastTrackTicketType) regardless of its event's type. True for every
  // existing type here to reflect that actual current behavior; only
  // CONCERT/FESTIVAL's values below reflect a real, considered choice.
  vipFastTrack: boolean;
  // NOT currently gated by eventType either — TicketGroup/shared wallets
  // work the same way on any event type today. Same "true for every
  // existing type" reasoning as vipFastTrack above.
  groupWallets: boolean;
  // No existing code checks this yet — CONCERT/FESTIVAL groundwork for a
  // later session.
  multiDayPass: boolean;
  // No existing code checks this yet — CONCERT/FESTIVAL groundwork for a
  // later session.
  stageSchedule: boolean;
}

function label(key: "general" | "marathon" | "conference" | "football" | "concert" | "festival") {
  return {
    label: dictionaries.en[`eventType.${key}`],
    labelSw: dictionaries.sw[`eventType.${key}`],
  };
}

export const EVENT_MODE_CONFIG: Record<EventType, EventModeConfig> = {
  GENERAL: {
    ...label("general"),
    defaultGateMode: "SINGLE_ENTRY",
    chipTiming: false,
    publicLeaderboard: false,
    sessionCheckIn: false,
    exhibitorLeads: false,
    vipFastTrack: true,
    groupWallets: true,
    multiDayPass: false,
    stageSchedule: false,
  },
  MARATHON: {
    ...label("marathon"),
    defaultGateMode: "SINGLE_ENTRY",
    chipTiming: true,
    publicLeaderboard: true,
    sessionCheckIn: false,
    exhibitorLeads: false,
    vipFastTrack: true,
    groupWallets: true,
    multiDayPass: false,
    stageSchedule: false,
  },
  CONFERENCE: {
    ...label("conference"),
    // Attendees move between session rooms rather than passing one gate —
    // the only existing type where admission isn't a single checkpoint.
    defaultGateMode: "MULTI_ZONE",
    chipTiming: false,
    publicLeaderboard: false,
    sessionCheckIn: true,
    exhibitorLeads: true,
    vipFastTrack: true,
    groupWallets: true,
    multiDayPass: false,
    stageSchedule: false,
  },
  FOOTBALL: {
    ...label("football"),
    defaultGateMode: "SINGLE_ENTRY",
    chipTiming: false,
    publicLeaderboard: false,
    sessionCheckIn: false,
    exhibitorLeads: false,
    vipFastTrack: true,
    groupWallets: true,
    multiDayPass: false,
    stageSchedule: false,
  },
  CONCERT: {
    ...label("concert"),
    defaultGateMode: "SINGLE_ENTRY",
    chipTiming: false,
    publicLeaderboard: false,
    sessionCheckIn: false,
    exhibitorLeads: false,
    vipFastTrack: true,
    groupWallets: false,
    multiDayPass: false,
    stageSchedule: false,
  },
  FESTIVAL: {
    ...label("festival"),
    // Multi-day festivals commonly involve attendees leaving and returning
    // (campgrounds, off-site meals) across the run, unlike a single-show
    // CONCERT.
    defaultGateMode: "REENTRY",
    chipTiming: false,
    publicLeaderboard: false,
    sessionCheckIn: false,
    exhibitorLeads: false,
    vipFastTrack: false,
    groupWallets: true,
    multiDayPass: false,
    stageSchedule: false,
  },
};

export function hasFeature(
  eventType: string,
  feature: keyof Omit<EventModeConfig, "label" | "labelSw" | "defaultGateMode">
): boolean {
  const config = EVENT_MODE_CONFIG[eventType as EventType];
  return config ? config[feature] : false;
}
