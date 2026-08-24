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
  organizerId: string;
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
  organizerId: string;
  syncStatus: "synced" | "pending";
}

export interface LocalSettlement {
  id: string;
  organizerId: string;
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
  | "APPROVE_VENDOR"
  | "REJECT_VENDOR"
  | "CHECK_IN_VENDOR";

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
  }
}

export const db =
  typeof window !== "undefined" ? new EventPassAfricaDB() : (null as unknown as EventPassAfricaDB);

export function newLocalId(): string {
  return `local:${crypto.randomUUID()}`;
}
