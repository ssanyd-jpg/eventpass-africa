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
  imageUrl: string;
  status: "LIVE" | "CANCELLED";
  currency: string;
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
  userId: string;
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
  balanceCents: number;
  currency: string;
  createdAt: string;
  updatedAt: string;
  syncStatus: "synced" | "pending";
}

export interface LocalWalletTransaction {
  id: string;
  clientId?: string | null;
  walletId: string;
  type: "TOPUP" | "SALE" | "SPONSOR_TAP";
  status: "PENDING" | "COMPLETED" | "FAILED";
  amountCents: number | null;
  currency: string;
  providerReference: string | null;
  providerMessage: string | null;
  phoneNumber: string | null;
  // SPONSOR_TAP only — a staff-entered lead note, see WalletTransaction.note
  // in prisma/schema.prisma.
  note: string | null;
  vendorId: string | null;
  vendorName: string | null;
  sponsorId: string | null;
  sponsorName: string | null;
  createdAt: string;
  updatedAt: string;
  syncStatus: "synced" | "pending" | "conflict";
  syncError?: string | null;
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
  | "SPONSOR_TAP";

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
