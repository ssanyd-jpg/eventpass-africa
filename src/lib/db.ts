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
}

export type OrderSyncStatus = "synced" | "pending" | "conflict";

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
  syncStatus: OrderSyncStatus;
  syncError?: string | null;
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
