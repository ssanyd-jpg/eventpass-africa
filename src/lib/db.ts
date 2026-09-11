import Dexie, { type Table } from "dexie";

export interface LocalTicketType {
  id: string;
  clientId?: string | null;
  name: string;
  description: string;
  priceCents: number;
  quantityTotal: number;
  quantitySold: number;
}

export interface LocalEventVendorSummary {
  id: string;
  name: string;
  category: string;
  boothNumber: string | null;
}

export interface LocalRegistrationQuestion {
  id: string;
  clientId?: string | null;
  label: string;
  type: "TEXT" | "SELECT" | "CHECKBOX";
  options: string | null;
  required: boolean;
  sortOrder: number;
}

export interface LocalEvent {
  id: string;
  clientId?: string | null;
  slug: string;
  title: string;
  description: string;
  category: string;
  venue: string;
  city: string;
  startsAt: string; // ISO
  // ISO, or null when not set — Session 11. Carry-over treats an event as
  // "ended" once (endsAt ?? startsAt) is in the past.
  endsAt: string | null;
  imageUrl: string;
  status: "LIVE" | "CANCELLED";
  currency: string;
  // Session 11 — organiser opt-in for wristband balance carry-over.
  carryOverEnabled: boolean;
  // Session 12 — GENERAL | MARATHON | CONFERENCE. MARATHON unlocks the
  // timing scanner, timing dashboard, and public leaderboard.
  eventType: "GENERAL" | "MARATHON" | "CONFERENCE";
  // ISO, or null before the race's "Start gun" action has run.
  gunStartAt: string | null;
  vendorApplicationsOpen: boolean;
  vendorStallFeeCents: number;
  organizationId: string;
  organizerName: string;
  createdAt: string;
  updatedAt: string;
  ticketTypes: LocalTicketType[];
  // Public summary of APPROVED vendors only — no contact info. The full
  // detail (contact, badgeCode, PENDING/REJECTED) lives in the separate
  // `vendors` table, populated only for the vendor's owner or the event's
  // organizer — see the pull route's public/private split.
  vendors: LocalEventVendorSummary[];
  waiverText: string | null;
  registrationQuestions: LocalRegistrationQuestion[];
  syncStatus: "synced" | "pending";
}

export interface LocalOrderItem {
  ticketTypeId: string;
  ticketTypeName: string;
  quantity: number;
  unitPriceCents: number;
}

export interface LocalTicket {
  id: string;
  clientId?: string | null;
  code: string;
  ticketTypeId: string;
  ticketTypeName: string;
  checkedIn: boolean;
  checkedInAt: string | null;
  // null = held by the order's own buyer (order.userId). Set once a
  // TicketTransfer to this ticket is accepted — see currentHolderUserId in
  // prisma/schema.prisma.
  currentHolderUserId?: string | null;
  // Session 13 — set when this ticket was purchased as part of a group/
  // family checkout (see Ticket.ticketGroupId/groupMemberName in
  // prisma/schema.prisma). groupMemberName is never a real account, just
  // the label the lead buyer typed for this specific wristband at checkout.
  ticketGroupId?: string | null;
  ticketGroupName?: string | null;
  groupMemberName?: string | null;
}

export type OrderSyncStatus = "synced" | "pending" | "conflict";

export interface LocalRegistrationAnswer {
  questionId: string;
  questionLabel: string;
  value: string;
}

export interface LocalOrder {
  id: string;
  clientId: string;
  status: string;
  totalCents: number;
  currency: string;
  createdAt: string;
  // Absent on the optimistic local echo written before sync (there's
  // nothing to date yet); filled in once the server-authoritative order
  // replaces it. Used by the organizer dashboard's stuck-PENDING-orders
  // section to tell how long an Airpay charge has actually been sitting.
  updatedAt?: string;
  userId: string;
  // The buyer's account age at pull time — organizer-visible only (this
  // field only ever gets populated for orders on events the caller
  // organizes, via myOrders in pull/route.ts), used for the "brand-new
  // account, large order" anomaly/risk signal (see anomaly.ts/risk.ts).
  userCreatedAt?: string;
  eventId: string;
  eventClientId?: string | null;
  eventTitle: string;
  items: LocalOrderItem[];
  tickets: LocalTicket[];
  waiverText: string | null;
  waiverAcceptedAt: string | null;
  answers: LocalRegistrationAnswer[];
  // Set server-side by handleSellTickets once the discount code (if any)
  // was validated against the matching ticket type — see
  // DiscountCode/Order.discountCents in prisma/schema.prisma. Absent on the
  // optimistic local echo written before sync; filled in once
  // applySellTicketsResult replaces it with the server-authoritative order.
  discountCents?: number;
  discountCode?: string | null;
  discountTicketTypeName?: string | null;
  // Informational only, never affects syncStatus — set only transiently on
  // the sync-push response when a typed code couldn't be applied (unknown/
  // expired/inactive/max-redeemed/wrong-ticket-type), so the buyer can see
  // why they were still charged in full.
  discountRejectReason?: string | null;
  // Airpay real-payment collection — mirrors LocalWalletTransaction's
  // providerReference/providerMessage. paymentMethod is "AIRPAY_ONLINE" |
  // "OFFLINE_DEFERRED" | null (legacy/unspecified, matches Order.paymentMethod).
  providerReference?: string | null;
  providerMessage?: string | null;
  paymentMethod?: string | null;
  syncStatus: OrderSyncStatus;
  syncError?: string | null;
}

// Organizer-only — never ships in the public `events` pull field (unlike
// ticketTypes), so an anonymous browser can't enumerate an event's promo
// codes out of IndexedDB. Populated only from payload.myDiscountCodes,
// scoped server-side to the caller's own organization — see pull/route.ts.
export interface LocalDiscountCode {
  id: string;
  clientId?: string | null;
  eventId: string;
  code: string;
  type: "PERCENT_OFF" | "FIXED_AMOUNT_OFF";
  percentOff: number | null;
  amountOffCents: number | null;
  ticketTypeId: string;
  ticketTypeName: string;
  maxRedemptions: number | null;
  redemptionCount: number;
  expiresAt: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

// Organizer-only, same reasoning as LocalDiscountCode — post-event survey
// questions are never needed pre-purchase, so they don't ride in the
// public `events` field. Populated from payload.mySurveyQuestions.
export interface LocalSurveyQuestion {
  id: string;
  clientId?: string | null;
  eventId: string;
  label: string;
  type: "TEXT" | "SELECT" | "CHECKBOX";
  options: string | null;
  required: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

// One row per event the caller has a completed order for, an event whose
// startsAt is >24h in the past, has organizer-defined survey questions, and
// no existing response from this buyer — see the lazy-trigger comment in
// pull/route.ts. Full-replace on every pull (clear+bulkPut), unlike every
// other table here, since this list must SHRINK as the buyer responds.
export interface LocalPendingSurvey {
  eventId: string;
  eventClientId?: string | null;
  eventTitle: string;
  questions: LocalRegistrationQuestion[];
}

// Same-category recommendations for the signed-in buyer — deterministic,
// not Claude-backed (see recommendations.ts). Only ids: the full LocalEvent
// shape for each id already lives in the `events` table (every LIVE event
// rides in the unconditional public `events` pull field), so this table is
// just a pointer list. Full-replace on every pull (clear+bulkPut), same
// reasoning as pendingSurveys — this list must change as purchase history
// and live events change.
export interface LocalRecommendedEvent {
  id: string; // = eventId
}

export interface LocalMobileMoneyAccount {
  id: string;
  clientId: string;
  provider: string;
  phoneNumber: string;
  accountName: string;
  isDefault: boolean;
  organizationId: string;
  syncStatus: "synced" | "pending";
}

export interface LocalSettlement {
  id: string;
  organizationId: string;
  mobileMoneyAccountId: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  grossCents: number;
  platformFeeCents: number;
  netCents: number;
  status: string;
  payoutReference: string | null;
  createdAt: string;
  paidAt: string | null;
}

export interface LocalVendor {
  id: string;
  clientId?: string | null;
  eventId: string;
  eventClientId?: string | null;
  name: string;
  category: string;
  description: string;
  contactEmail: string;
  contactPhone: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  boothNumber: string | null;
  stallFeeCents: number;
  currency: string;
  feeStatus: "NONE" | "PAID" | "REFUNDED";
  ownerUserId: string | null;
  badgeCode: string | null;
  checkedIn: boolean;
  checkedInAt: string | null;
  // Session 8's vendor portal settlement — see the matching comment on the
  // Vendor model in prisma/schema.prisma. Set via the organiser's
  // markVendorSettlementProcessing/Processed Server Actions, not an outbox
  // op (same reasoning as badgeCode replacement above — an online-only
  // organiser action, optimistically merged in locally after it resolves).
  settlementStatus: "PENDING" | "PROCESSING" | "SETTLED";
  settlementAmountCents: number;
  settlementProcessedAt: string | null;
  createdAt: string;
  updatedAt: string;
  syncStatus: "synced" | "pending";
}

export interface LocalSponsor {
  id: string;
  clientId?: string | null;
  eventId: string;
  eventClientId?: string | null;
  name: string;
  tier: string;
  description: string;
  contactEmail: string;
  contactPhone: string;
  feeCents: number;
  currency: string;
  feeStatus: "NONE" | "PAID";
  createdAt: string;
  updatedAt: string;
  syncStatus: "synced" | "pending";
}

export interface LocalWallet {
  id: string;
  clientId?: string | null;
  code: string;
  eventId: string;
  eventClientId?: string | null;
  ownerUserId: string;
  // Organizer-visible only in practice — surfaced so the withdrawal review
  // queue (see LocalWalletTransaction's WITHDRAWAL type below) can show who
  // to pay. Absent/null for a buyer's own view of their own wallet is fine,
  // they already know who they are.
  ownerName: string | null;
  ownerEmail: string | null;
  balanceCents: number;
  currency: string;
  // Session 11 — set on a wallet created by carrying a balance over from a
  // previous event's wallet. The source event's title for the "Carried over
  // from …" note is resolved client-side (source wallet → its event), not
  // stored here.
  carryOverSourceWalletId: string | null;
  carryOverredAt: string | null;
  // Session 13 — true when this is a group/family's shared wallet rather
  // than a personal one (see Wallet.isGroupWallet). groupName is the
  // group's display name, present whenever isGroupWallet is true.
  isGroupWallet?: boolean;
  groupName?: string | null;
  createdAt: string;
  updatedAt: string;
  syncStatus: "synced" | "pending";
}

// NFC wristband resolution only — a purely client-side uid->code translation
// table (see src/lib/credentials.ts's resolveCodeFromUid), never read for
// anything else. Full-replaced on every pull rather than merged, since a
// SUPERSEDED transition (a tag reassigned to someone else) must promptly
// stop the old row from resolving on every device, and Credential has no
// clientId/updatedAt to key an incremental merge on.
//
// The pull route ships SUPERSEDED rows too, not just ACTIVE ones (see
// pull/route.ts) — needed so a gate/wallet terminal can tell "this exact
// wristband was replaced" (isUidSuperseded in credentials.ts) apart from
// "never provisioned," which a purely-ACTIVE cache couldn't distinguish.
export interface LocalCredential {
  id: string;
  nfcUid: string;
  status: string;
  ticketId: string | null;
  walletId: string | null;
  code: string;
  // Both optional — absent on the optimistic local rows a provisioning/
  // replacement page writes before syncing, filled in once the server's
  // authoritative row lands.
  createdAt?: string;
  supersededAt?: string | null;
}

// Session 12 — synced down to any device that needs to know a marathon's
// course layout: the timing scanner (picking which point this device
// operates) and the timing dashboard/leaderboard (labels, sequence,
// distance for pace). Organiser-authored via a Server Action (race setup
// is a desk job before race day, not a field outbox op), but read
// everywhere via the normal pull sync like any other event sub-resource.
export interface LocalTimingPoint {
  id: string;
  clientId?: string | null;
  eventId: string;
  eventClientId?: string | null;
  name: string;
  location: string;
  sequenceOrder: number;
  isStart: boolean;
  isFinish: boolean;
  distanceMeters: number | null;
  createdAt: string;
  updatedAt: string;
}

// Session 12 — a timing operator's own recent taps at THEIR device, for the
// scanner page's "last 10 recorded times" feed. Deliberately NOT synced
// down from the server for every athlete/event (that could be tens of
// thousands of rows for a large marathon, and no page needs someone else's
// device's history) — populated only by this device's own successful
// RECORD_CHIP_TIME results, same as how the wallet terminal's own tap
// history stays local-only.
export interface LocalChipTime {
  id: string;
  clientId?: string | null;
  eventId: string;
  timingPointId: string;
  timingPointName: string;
  credentialId: string;
  athleteName: string;
  bib: string;
  ticketTypeName: string;
  recordedAt: string;
  gunTimeOffsetSeconds: number | null;
  splitTimeSeconds: number | null;
  syncStatus: "synced" | "pending";
}

export interface LocalWalletTransaction {
  id: string;
  clientId?: string | null;
  walletId: string;
  type: "TOPUP" | "SALE" | "SPONSOR_TAP" | "WITHDRAWAL" | "CARRY_OVER";
  status: "PENDING" | "COMPLETED" | "FAILED";
  amountCents: number | null;
  currency: string;
  providerReference: string | null;
  providerMessage: string | null;
  phoneNumber: string | null;
  // WITHDRAWAL only — which network the organizer should pay out on. TOPUP's
  // payload has long accepted one too but never persisted it server-side.
  mobileNetwork: string | null;
  // SPONSOR_TAP only — a staff-entered lead note, see WalletTransaction.note
  // in prisma/schema.prisma.
  note: string | null;
  // SALE only — what was sold, staff-typed at the wallet charge terminal
  // (see WalletTransaction.item in prisma/schema.prisma).
  item: string | null;
  // Session 13 — SALE only, and only when the charge was resolved via an
  // NFC tap on a group wallet (see handleChargeWallet's attendeeTicketId).
  // Null otherwise, including for a charge on the same wallet made by typed
  // code/QR scan instead of a tap.
  spentByTicketId: string | null;
  spentByMemberName: string | null;
  vendorId: string | null;
  vendorName: string | null;
  sponsorId: string | null;
  sponsorName: string | null;
  // SPONSOR_TAP only — set iff this tap redeemed a SponsorCampaign, see
  // WalletTransaction.campaignId in prisma/schema.prisma.
  campaignId: string | null;
  campaignName: string | null;
  // Informational only, never persisted server-side — same discipline as
  // LocalOrder.discountRejectReason. Set only transiently on the
  // sync-push response when a selected campaign couldn't be redeemed
  // (unknown/inactive/expired/already-redeemed/max-redeemed), so the scan
  // terminal can tell staff why, without ever blocking the tap itself.
  campaignRejectReason?: string | null;
  createdAt: string;
  updatedAt: string;
  syncStatus: "synced" | "pending" | "conflict";
  syncError?: string | null;
}

// Organizer-only, same reasoning as LocalDiscountCode — a sponsor's
// coupon/campaign codes never ride in the public `events` field, so an
// anonymous browser can't enumerate them. Populated from
// payload.myCampaigns, scoped server-side to the caller's own organization.
export interface LocalSponsorCampaign {
  id: string;
  clientId?: string | null;
  sponsorId: string;
  name: string;
  code: string;
  maxRedemptions: number | null;
  redemptionCount: number;
  expiresAt: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export type OutboxOpType =
  | "CREATE_EVENT"
  | "EDIT_EVENT"
  | "CANCEL_EVENT"
  | "SELL_TICKETS"
  | "CHECK_IN"
  | "REFUND_ORDER"
  | "ADD_MOBILE_MONEY_ACCOUNT"
  | "APPLY_VENDOR"
  | "ADD_VENDOR"
  | "ADD_SPONSOR"
  | "APPROVE_VENDOR"
  | "REJECT_VENDOR"
  | "CHECK_IN_VENDOR"
  | "CREATE_WALLET"
  | "TOPUP_WALLET"
  | "CHECK_TOPUP_STATUS"
  | "CHARGE_WALLET"
  | "WITHDRAW_WALLET"
  | "APPROVE_WITHDRAWAL"
  | "REJECT_WITHDRAWAL"
  | "SPONSOR_TAP"
  | "ADD_SPONSOR_CAMPAIGN"
  | "DEACTIVATE_SPONSOR_CAMPAIGN"
  | "CHECK_ORDER_PAYMENT_STATUS"
  | "PROVISION_CREDENTIAL"
  | "REPLACE_CREDENTIAL"
  | "CANCEL_PENDING_ORDER"
  | "MARK_ORDER_PAID"
  | "CARRY_OVER_WALLET"
  | "RECORD_CHIP_TIME";

export interface OutboxEntry {
  id?: number;
  type: OutboxOpType;
  payload: Record<string, unknown>;
  createdAt: string;
  status: "pending" | "syncing" | "failed";
  attempts: number;
  lastError?: string | null;
}

export interface MetaEntry {
  key: string;
  value: unknown;
}

class EventPassAfricaDB extends Dexie {
  events!: Table<LocalEvent, string>;
  orders!: Table<LocalOrder, string>;
  mobileMoneyAccounts!: Table<LocalMobileMoneyAccount, string>;
  settlements!: Table<LocalSettlement, string>;
  outbox!: Table<OutboxEntry, number>;
  meta!: Table<MetaEntry, string>;
  vendors!: Table<LocalVendor, string>;
  sponsors!: Table<LocalSponsor, string>;
  wallets!: Table<LocalWallet, string>;
  walletTransactions!: Table<LocalWalletTransaction, string>;
  discountCodes!: Table<LocalDiscountCode, string>;
  surveyQuestions!: Table<LocalSurveyQuestion, string>;
  pendingSurveys!: Table<LocalPendingSurvey, string>;
  sponsorCampaigns!: Table<LocalSponsorCampaign, string>;
  recommendedEvents!: Table<LocalRecommendedEvent, string>;
  credentials!: Table<LocalCredential, string>;
  timingPoints!: Table<LocalTimingPoint, string>;
  chipTimes!: Table<LocalChipTime, string>;

  constructor() {
    super("eventpass-africa");
    this.version(1).stores({
      events: "id, clientId, slug, organizerId, category, startsAt",
      orders: "id, clientId, userId, eventId, syncStatus, createdAt",
      mobileMoneyAccounts: "id, clientId, organizerId",
      settlements: "id, organizerId, status, createdAt",
      outbox: "++id, status, type, createdAt",
      meta: "key",
    });
    this.version(2).stores({
      events: "id, clientId, slug, organizerId, category, startsAt",
      orders: "id, clientId, userId, eventId, syncStatus, createdAt",
      mobileMoneyAccounts: "id, clientId, organizerId",
      settlements: "id, organizerId, status, createdAt",
      outbox: "++id, status, type, createdAt",
      meta: "key",
      vendors: "id, clientId, eventId, ownerUserId, badgeCode, status, syncStatus",
    });
    this.version(3).stores({
      events: "id, clientId, slug, organizerId, category, startsAt",
      orders: "id, clientId, userId, eventId, syncStatus, createdAt",
      mobileMoneyAccounts: "id, clientId, organizerId",
      settlements: "id, organizerId, status, createdAt",
      outbox: "++id, status, type, createdAt",
      meta: "key",
      vendors: "id, clientId, eventId, ownerUserId, badgeCode, status, syncStatus",
      wallets: "id, clientId, eventId, ownerUserId, code, syncStatus",
      walletTransactions: "id, clientId, walletId, type, status, syncStatus, createdAt",
    });
    // organizerId -> organizationId rename (events/mobileMoneyAccounts/
    // settlements now belong to an Organization, not directly to a User —
    // see prisma/schema.prisma). No .upgrade() transform needed, matching
    // every prior version bump in this file: pullFromServer() runs on every
    // app mount and bulkPuts fresh server data straight over any stale local
    // shape.
    this.version(4).stores({
      events: "id, clientId, slug, organizationId, category, startsAt",
      orders: "id, clientId, userId, eventId, syncStatus, createdAt",
      mobileMoneyAccounts: "id, clientId, organizationId",
      settlements: "id, organizationId, status, createdAt",
      outbox: "++id, status, type, createdAt",
      meta: "key",
      vendors: "id, clientId, eventId, ownerUserId, badgeCode, status, syncStatus",
      wallets: "id, clientId, eventId, ownerUserId, code, syncStatus",
      walletTransactions: "id, clientId, walletId, type, status, syncStatus, createdAt",
    });
    // sponsorZoneLabel -> sponsorId/sponsorName on walletTransactions (a real
    // Sponsor entity now, not a free-text string), plus the new sponsors
    // table. No .upgrade() transform, same reasoning as version(4).
    this.version(5).stores({
      events: "id, clientId, slug, organizationId, category, startsAt",
      orders: "id, clientId, userId, eventId, syncStatus, createdAt",
      mobileMoneyAccounts: "id, clientId, organizationId",
      settlements: "id, organizationId, status, createdAt",
      outbox: "++id, status, type, createdAt",
      meta: "key",
      vendors: "id, clientId, eventId, ownerUserId, badgeCode, status, syncStatus",
      wallets: "id, clientId, eventId, ownerUserId, code, syncStatus",
      walletTransactions: "id, clientId, walletId, type, status, syncStatus, createdAt",
      sponsors: "id, clientId, eventId, syncStatus",
    });
    // New organizer-only discountCodes table (see LocalDiscountCode above).
    // No .upgrade() transform, same reasoning as version(4)/version(5).
    this.version(6).stores({
      events: "id, clientId, slug, organizationId, category, startsAt",
      orders: "id, clientId, userId, eventId, syncStatus, createdAt",
      mobileMoneyAccounts: "id, clientId, organizationId",
      settlements: "id, organizationId, status, createdAt",
      outbox: "++id, status, type, createdAt",
      meta: "key",
      vendors: "id, clientId, eventId, ownerUserId, badgeCode, status, syncStatus",
      wallets: "id, clientId, eventId, ownerUserId, code, syncStatus",
      walletTransactions: "id, clientId, walletId, type, status, syncStatus, createdAt",
      sponsors: "id, clientId, eventId, syncStatus",
      discountCodes: "id, clientId, eventId, ticketTypeId, code",
    });
    // New organizer-only surveyQuestions table (mirrors discountCodes) and
    // pendingSurveys table (keyPath eventId, no auto-increment — it's
    // fully replaced on every pull, not appended to). No .upgrade()
    // transform, same reasoning as every prior version bump in this file.
    this.version(7).stores({
      events: "id, clientId, slug, organizationId, category, startsAt",
      orders: "id, clientId, userId, eventId, syncStatus, createdAt",
      mobileMoneyAccounts: "id, clientId, organizationId",
      settlements: "id, organizationId, status, createdAt",
      outbox: "++id, status, type, createdAt",
      meta: "key",
      vendors: "id, clientId, eventId, ownerUserId, badgeCode, status, syncStatus",
      wallets: "id, clientId, eventId, ownerUserId, code, syncStatus",
      walletTransactions: "id, clientId, walletId, type, status, syncStatus, createdAt",
      sponsors: "id, clientId, eventId, syncStatus",
      discountCodes: "id, clientId, eventId, ticketTypeId, code",
      surveyQuestions: "id, clientId, eventId",
      pendingSurveys: "eventId",
    });
    // New organizer-only sponsorCampaigns table (mirrors discountCodes),
    // plus campaignId/campaignName on walletTransactions (still indexed
    // the same way — campaignId isn't queried by itself client-side, only
    // filtered in-memory by sponsorId). No .upgrade() transform, same
    // reasoning as every prior version bump in this file.
    this.version(8).stores({
      events: "id, clientId, slug, organizationId, category, startsAt",
      orders: "id, clientId, userId, eventId, syncStatus, createdAt",
      mobileMoneyAccounts: "id, clientId, organizationId",
      settlements: "id, organizationId, status, createdAt",
      outbox: "++id, status, type, createdAt",
      meta: "key",
      vendors: "id, clientId, eventId, ownerUserId, badgeCode, status, syncStatus",
      wallets: "id, clientId, eventId, ownerUserId, code, syncStatus",
      walletTransactions: "id, clientId, walletId, type, status, syncStatus, createdAt",
      sponsors: "id, clientId, eventId, syncStatus",
      discountCodes: "id, clientId, eventId, ticketTypeId, code",
      surveyQuestions: "id, clientId, eventId",
      pendingSurveys: "eventId",
      sponsorCampaigns: "id, clientId, sponsorId, code",
    });
    // New recommendedEvents table (see LocalRecommendedEvent above) — a
    // pointer list of event ids, full-replaced on every pull. No .upgrade()
    // transform, same reasoning as every prior version bump in this file.
    this.version(9).stores({
      events: "id, clientId, slug, organizationId, category, startsAt",
      orders: "id, clientId, userId, eventId, syncStatus, createdAt",
      mobileMoneyAccounts: "id, clientId, organizationId",
      settlements: "id, organizationId, status, createdAt",
      outbox: "++id, status, type, createdAt",
      meta: "key",
      vendors: "id, clientId, eventId, ownerUserId, badgeCode, status, syncStatus",
      wallets: "id, clientId, eventId, ownerUserId, code, syncStatus",
      walletTransactions: "id, clientId, walletId, type, status, syncStatus, createdAt",
      sponsors: "id, clientId, eventId, syncStatus",
      discountCodes: "id, clientId, eventId, ticketTypeId, code",
      surveyQuestions: "id, clientId, eventId",
      pendingSurveys: "eventId",
      sponsorCampaigns: "id, clientId, sponsorId, code",
      recommendedEvents: "id",
    });
    // New `mobileNetwork` field on walletTransactions and `ownerName`/
    // `ownerEmail` on wallets (see LocalWallet/LocalWalletTransaction
    // above) — no indexed-key change, so this bump is purely a changelog
    // marker; no .upgrade() transform needed, same reasoning as every
    // prior bump.
    this.version(10).stores({
      events: "id, clientId, slug, organizationId, category, startsAt",
      orders: "id, clientId, userId, eventId, syncStatus, createdAt",
      mobileMoneyAccounts: "id, clientId, organizationId",
      settlements: "id, organizationId, status, createdAt",
      outbox: "++id, status, type, createdAt",
      meta: "key",
      vendors: "id, clientId, eventId, ownerUserId, badgeCode, status, syncStatus",
      wallets: "id, clientId, eventId, ownerUserId, code, syncStatus",
      walletTransactions: "id, clientId, walletId, type, status, syncStatus, createdAt",
      sponsors: "id, clientId, eventId, syncStatus",
      discountCodes: "id, clientId, eventId, ticketTypeId, code",
      surveyQuestions: "id, clientId, eventId",
      pendingSurveys: "eventId",
      sponsorCampaigns: "id, clientId, sponsorId, code",
      recommendedEvents: "id",
    });
    // New `providerReference`/`providerMessage`/`paymentMethod` fields on
    // orders (see LocalOrder above, for real Airpay payment collection) —
    // no indexed-key change, so this bump is purely a changelog marker; no
    // .upgrade() transform needed, same reasoning as every prior bump.
    this.version(11).stores({
      events: "id, clientId, slug, organizationId, category, startsAt",
      orders: "id, clientId, userId, eventId, syncStatus, createdAt",
      mobileMoneyAccounts: "id, clientId, organizationId",
      settlements: "id, organizationId, status, createdAt",
      outbox: "++id, status, type, createdAt",
      meta: "key",
      vendors: "id, clientId, eventId, ownerUserId, badgeCode, status, syncStatus",
      wallets: "id, clientId, eventId, ownerUserId, code, syncStatus",
      walletTransactions: "id, clientId, walletId, type, status, syncStatus, createdAt",
      sponsors: "id, clientId, eventId, syncStatus",
      discountCodes: "id, clientId, eventId, ticketTypeId, code",
      surveyQuestions: "id, clientId, eventId",
      pendingSurveys: "eventId",
      sponsorCampaigns: "id, clientId, sponsorId, code",
      recommendedEvents: "id",
    });
    // New `credentials` table (see LocalCredential above) for NFC wristband
    // uid->code resolution — a genuinely new store, not a field addition to
    // an existing one, but still no .upgrade() transform needed: it's
    // full-replaced on every pull, same reasoning as pendingSurveys/
    // recommendedEvents above.
    this.version(12).stores({
      events: "id, clientId, slug, organizationId, category, startsAt",
      orders: "id, clientId, userId, eventId, syncStatus, createdAt",
      mobileMoneyAccounts: "id, clientId, organizationId",
      settlements: "id, organizationId, status, createdAt",
      outbox: "++id, status, type, createdAt",
      meta: "key",
      vendors: "id, clientId, eventId, ownerUserId, badgeCode, status, syncStatus",
      wallets: "id, clientId, eventId, ownerUserId, code, syncStatus",
      walletTransactions: "id, clientId, walletId, type, status, syncStatus, createdAt",
      sponsors: "id, clientId, eventId, syncStatus",
      discountCodes: "id, clientId, eventId, ticketTypeId, code",
      surveyQuestions: "id, clientId, eventId",
      pendingSurveys: "eventId",
      sponsorCampaigns: "id, clientId, sponsorId, code",
      recommendedEvents: "id",
      credentials: "id, nfcUid, ticketId, walletId, status",
    });
    // New `createdAt`/`supersededAt` fields on LocalCredential (see above,
    // for the wristband replacement flow) — no indexed-key change, so this
    // bump is purely a changelog marker; no .upgrade() transform needed,
    // same reasoning as every prior field-addition bump in this file.
    this.version(13).stores({
      events: "id, clientId, slug, organizationId, category, startsAt",
      orders: "id, clientId, userId, eventId, syncStatus, createdAt",
      mobileMoneyAccounts: "id, clientId, organizationId",
      settlements: "id, organizationId, status, createdAt",
      outbox: "++id, status, type, createdAt",
      meta: "key",
      vendors: "id, clientId, eventId, ownerUserId, badgeCode, status, syncStatus",
      wallets: "id, clientId, eventId, ownerUserId, code, syncStatus",
      walletTransactions: "id, clientId, walletId, type, status, syncStatus, createdAt",
      sponsors: "id, clientId, eventId, syncStatus",
      discountCodes: "id, clientId, eventId, ticketTypeId, code",
      surveyQuestions: "id, clientId, eventId",
      pendingSurveys: "eventId",
      sponsorCampaigns: "id, clientId, sponsorId, code",
      recommendedEvents: "id",
      credentials: "id, nfcUid, ticketId, walletId, status",
    });
    // New `updatedAt` field on LocalOrder (see above, for the organizer
    // dashboard's stuck-PENDING-orders section) — no indexed-key change,
    // so this bump is purely a changelog marker; no .upgrade() transform
    // needed, same reasoning as every prior field-addition bump.
    this.version(14).stores({
      events: "id, clientId, slug, organizationId, category, startsAt",
      orders: "id, clientId, userId, eventId, syncStatus, createdAt",
      mobileMoneyAccounts: "id, clientId, organizationId",
      settlements: "id, organizationId, status, createdAt",
      outbox: "++id, status, type, createdAt",
      meta: "key",
      vendors: "id, clientId, eventId, ownerUserId, badgeCode, status, syncStatus",
      wallets: "id, clientId, eventId, ownerUserId, code, syncStatus",
      walletTransactions: "id, clientId, walletId, type, status, syncStatus, createdAt",
      sponsors: "id, clientId, eventId, syncStatus",
      discountCodes: "id, clientId, eventId, ticketTypeId, code",
      surveyQuestions: "id, clientId, eventId",
      pendingSurveys: "eventId",
      sponsorCampaigns: "id, clientId, sponsorId, code",
      recommendedEvents: "id",
      credentials: "id, nfcUid, ticketId, walletId, status",
    });
    // Session 8's vendor portal: new `item` field on LocalWalletTransaction
    // and new settlementStatus/settlementAmountCents/settlementProcessedAt
    // fields on LocalVendor (see prisma/schema.prisma) — no indexed-key
    // change, same no-.upgrade()-needed reasoning as version 14.
    this.version(15).stores({
      events: "id, clientId, slug, organizationId, category, startsAt",
      orders: "id, clientId, userId, eventId, syncStatus, createdAt",
      mobileMoneyAccounts: "id, clientId, organizationId",
      settlements: "id, organizationId, status, createdAt",
      outbox: "++id, status, type, createdAt",
      meta: "key",
      vendors: "id, clientId, eventId, ownerUserId, badgeCode, status, syncStatus",
      wallets: "id, clientId, eventId, ownerUserId, code, syncStatus",
      walletTransactions: "id, clientId, walletId, type, status, syncStatus, createdAt",
      sponsors: "id, clientId, eventId, syncStatus",
      discountCodes: "id, clientId, eventId, ticketTypeId, code",
      surveyQuestions: "id, clientId, eventId",
      pendingSurveys: "eventId",
      sponsorCampaigns: "id, clientId, sponsorId, code",
      recommendedEvents: "id",
      credentials: "id, nfcUid, ticketId, walletId, status",
    });
    // Session 11: new endsAt/carryOverEnabled fields on LocalEvent and
    // carryOverSourceWalletId/carryOverredAt on LocalWallet (see
    // prisma/schema.prisma) — no indexed-key change, same
    // no-.upgrade()-needed reasoning as version 15.
    this.version(16).stores({
      events: "id, clientId, slug, organizationId, category, startsAt",
      orders: "id, clientId, userId, eventId, syncStatus, createdAt",
      mobileMoneyAccounts: "id, clientId, organizationId",
      settlements: "id, organizationId, status, createdAt",
      outbox: "++id, status, type, createdAt",
      meta: "key",
      vendors: "id, clientId, eventId, ownerUserId, badgeCode, status, syncStatus",
      wallets: "id, clientId, eventId, ownerUserId, code, syncStatus",
      walletTransactions: "id, clientId, walletId, type, status, syncStatus, createdAt",
      sponsors: "id, clientId, eventId, syncStatus",
      discountCodes: "id, clientId, eventId, ticketTypeId, code",
      surveyQuestions: "id, clientId, eventId",
      pendingSurveys: "eventId",
      sponsorCampaigns: "id, clientId, sponsorId, code",
      recommendedEvents: "id",
      credentials: "id, nfcUid, ticketId, walletId, status",
    });
    // Session 12: new eventType/gunStartAt fields on LocalEvent (no
    // indexed-key change), plus two genuinely new stores — timingPoints
    // (full-replaced on every pull, same as credentials/pendingSurveys) and
    // chipTimes (local-only device activity feed, never pulled — see
    // LocalChipTime's own comment).
    this.version(17).stores({
      events: "id, clientId, slug, organizationId, category, startsAt",
      orders: "id, clientId, userId, eventId, syncStatus, createdAt",
      mobileMoneyAccounts: "id, clientId, organizationId",
      settlements: "id, organizationId, status, createdAt",
      outbox: "++id, status, type, createdAt",
      meta: "key",
      vendors: "id, clientId, eventId, ownerUserId, badgeCode, status, syncStatus",
      wallets: "id, clientId, eventId, ownerUserId, code, syncStatus",
      walletTransactions: "id, clientId, walletId, type, status, syncStatus, createdAt",
      sponsors: "id, clientId, eventId, syncStatus",
      discountCodes: "id, clientId, eventId, ticketTypeId, code",
      surveyQuestions: "id, clientId, eventId",
      pendingSurveys: "eventId",
      sponsorCampaigns: "id, clientId, sponsorId, code",
      recommendedEvents: "id",
      credentials: "id, nfcUid, ticketId, walletId, status",
      timingPoints: "id, clientId, eventId, sequenceOrder",
      chipTimes: "id, clientId, eventId, timingPointId, recordedAt",
    });
    // Session 13: new ticketGroupId/ticketGroupName/groupMemberName fields
    // on LocalTicket (embedded in LocalOrder.tickets), isGroupWallet/
    // groupName on LocalWallet, and spentByTicketId/spentByMemberName on
    // LocalWalletTransaction — no indexed-key change, same no-.upgrade()-
    // needed reasoning as version 15/16.
    this.version(18).stores({
      events: "id, clientId, slug, organizationId, category, startsAt",
      orders: "id, clientId, userId, eventId, syncStatus, createdAt",
      mobileMoneyAccounts: "id, clientId, organizationId",
      settlements: "id, organizationId, status, createdAt",
      outbox: "++id, status, type, createdAt",
      meta: "key",
      vendors: "id, clientId, eventId, ownerUserId, badgeCode, status, syncStatus",
      wallets: "id, clientId, eventId, ownerUserId, code, syncStatus",
      walletTransactions: "id, clientId, walletId, type, status, syncStatus, createdAt",
      sponsors: "id, clientId, eventId, syncStatus",
      discountCodes: "id, clientId, eventId, ticketTypeId, code",
      surveyQuestions: "id, clientId, eventId",
      pendingSurveys: "eventId",
      sponsorCampaigns: "id, clientId, sponsorId, code",
      recommendedEvents: "id",
      credentials: "id, nfcUid, ticketId, walletId, status",
      timingPoints: "id, clientId, eventId, sequenceOrder",
      chipTimes: "id, clientId, eventId, timingPointId, recordedAt",
    });
  }
}

export const db =
  typeof window !== "undefined" ? new EventPassAfricaDB() : (null as unknown as EventPassAfricaDB);

export function newLocalId(): string {
  return `local:${crypto.randomUUID()}`;
}

// A persistent id for this browser/PWA install — generated once and reused
// on every subsequent sync call, unlike newLocalId() above (a fresh id per
// operation). Stored in the schemaless meta table, same one lastSyncedAt
// already lives in — no .version() bump needed for a new key there.
export async function getOrCreateDeviceId(): Promise<string> {
  if (!db) return "";
  const existing = await db.meta.get("deviceId");
  if (existing && typeof existing.value === "string") return existing.value;
  const id = crypto.randomUUID();
  await db.meta.put({ key: "deviceId", value: id });
  return id;
}
