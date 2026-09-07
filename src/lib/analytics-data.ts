import { prisma } from "@/lib/prisma";
import { trendWindowStart } from "@/lib/analytics";

// Prisma-touching fetchers for the analytics dashboards, kept out of
// analytics.ts on purpose — that file is pure/DB-free (see its own header
// comment) so its shaping functions stay unit-testable without a database.
// Both the dashboard pages and their CSV export routes call these, so the
// query shape only has to be maintained in one place.

export interface OrganizerAnalyticsRawData {
  myEvents: { id: string; title: string }[];
  revenueOrders: { createdAt: Date; totalCents: number; currency: string }[];
  ticketTypes: {
    id: string;
    name: string;
    quantityTotal: number;
    quantitySold: number;
    event: { title: string };
  }[];
  tickets: { eventId: string; createdAt: Date; checkedIn: boolean }[];
  vendors: { status: string; feeStatus: string; stallFeeCents: number; currency: string }[];
  wallets: { balanceCents: number; currency: string }[];
  walletTxs: {
    type: string;
    status: string;
    amountCents: number | null;
    currency: string;
    sponsor: { id: string; name: string } | null;
    vendor: { id: string; name: string } | null;
  }[];
}

export async function getOrganizerAnalyticsData(organizationId: string): Promise<OrganizerAnalyticsRawData> {
  const myEvents = await prisma.event.findMany({
    where: { organizationId },
    select: { id: true, title: true },
  });

  const eventIds = myEvents.map((e) => e.id);
  const windowStart = trendWindowStart();

  const [revenueOrders, ticketTypes, tickets, vendors, wallets, walletTxs] = await Promise.all([
    prisma.order.findMany({
      where: { eventId: { in: eventIds }, status: { in: ["PAID", "NEEDS_REVIEW"] }, createdAt: { gte: windowStart } },
      select: { createdAt: true, totalCents: true, currency: true },
    }),
    prisma.ticketType.findMany({
      where: { eventId: { in: eventIds } },
      select: { id: true, name: true, quantityTotal: true, quantitySold: true, event: { select: { title: true } } },
    }),
    prisma.ticket.findMany({
      // Allowlist, matching the revenue query above — a still-PENDING
      // (unpaid) or PAYMENT_FAILED order's tickets aren't real sales/
      // check-in-rate data yet, same reasoning as excluding REFUNDED.
      where: { eventId: { in: eventIds }, order: { status: { in: ["PAID", "NEEDS_REVIEW"] } } },
      select: { eventId: true, createdAt: true, checkedIn: true },
    }),
    prisma.vendor.findMany({
      where: { eventId: { in: eventIds } },
      select: { status: true, feeStatus: true, stallFeeCents: true, currency: true },
    }),
    prisma.wallet.findMany({
      where: { eventId: { in: eventIds } },
      select: { balanceCents: true, currency: true },
    }),
    prisma.walletTransaction.findMany({
      where: { wallet: { eventId: { in: eventIds } } },
      select: {
        type: true,
        status: true,
        amountCents: true,
        currency: true,
        sponsor: { select: { id: true, name: true } },
        vendor: { select: { id: true, name: true } },
      },
    }),
  ]);

  return { myEvents, revenueOrders, ticketTypes, tickets, vendors, wallets, walletTxs };
}

export interface PlatformAnalyticsRawData {
  events: { id: string; title: string }[];
  revenueOrders: { createdAt: Date; totalCents: number; currency: string }[];
  ticketTypes: {
    id: string;
    name: string;
    quantityTotal: number;
    quantitySold: number;
    event: { id: string; title: string };
  }[];
  tickets: { eventId: string; createdAt: Date; checkedIn: boolean }[];
  vendors: { status: string; feeStatus: string; stallFeeCents: number; currency: string }[];
  revenueOrdersWithOrganizer: {
    totalCents: number;
    currency: string;
    event: { organizationId: string; organization: { name: string } };
  }[];
  wallets: { balanceCents: number; currency: string }[];
  walletTxs: {
    type: string;
    status: string;
    amountCents: number | null;
    currency: string;
    sponsor: { id: string; name: string } | null;
    vendor: { id: string; name: string } | null;
  }[];
}

export async function getPlatformAnalyticsData(): Promise<PlatformAnalyticsRawData> {
  const windowStart = trendWindowStart();

  const [events, revenueOrders, ticketTypes, tickets, vendors, revenueOrdersWithOrganizer, wallets, walletTxs] =
    await Promise.all([
      prisma.event.findMany({ select: { id: true, title: true } }),
      prisma.order.findMany({
        where: { status: { in: ["PAID", "NEEDS_REVIEW"] }, createdAt: { gte: windowStart } },
        select: { createdAt: true, totalCents: true, currency: true },
      }),
      prisma.ticketType.findMany({
        select: { id: true, name: true, quantityTotal: true, quantitySold: true, event: { select: { id: true, title: true } } },
      }),
      prisma.ticket.findMany({
        // Allowlist, matching the revenue query above — see the identical
        // comment on the organizer-scoped query.
        where: { order: { status: { in: ["PAID", "NEEDS_REVIEW"] } } },
        select: { eventId: true, createdAt: true, checkedIn: true },
      }),
      prisma.vendor.findMany({
        select: { status: true, feeStatus: true, stallFeeCents: true, currency: true },
      }),
      prisma.order.findMany({
        where: { status: { in: ["PAID", "NEEDS_REVIEW"] }, createdAt: { gte: windowStart } },
        select: {
          totalCents: true,
          currency: true,
          event: { select: { organizationId: true, organization: { select: { name: true } } } },
        },
      }),
      prisma.wallet.findMany({ select: { balanceCents: true, currency: true } }),
      prisma.walletTransaction.findMany({
        select: {
          type: true,
          status: true,
          amountCents: true,
          currency: true,
          sponsor: { select: { id: true, name: true } },
          vendor: { select: { id: true, name: true } },
        },
      }),
    ]);

  return { events, revenueOrders, ticketTypes, tickets, vendors, revenueOrdersWithOrganizer, wallets, walletTxs };
}

export interface CustomerListOrder {
  userId: string;
  user: { name: string; email: string };
  totalCents: number;
  currency: string;
  createdAt: Date;
}

// Lifetime stats need every order ever, unlike the 30-day analytics
// dashboard above — deliberately no trendWindowStart() gate here.
export async function getCustomerListData(organizationId: string): Promise<CustomerListOrder[]> {
  const myEvents = await prisma.event.findMany({ where: { organizationId }, select: { id: true } });
  const eventIds = myEvents.map((e) => e.id);
  return prisma.order.findMany({
    where: { eventId: { in: eventIds }, status: { in: ["PAID", "NEEDS_REVIEW"] } },
    select: { userId: true, user: { select: { name: true, email: true } }, totalCents: true, currency: true, createdAt: true },
  });
}

export interface CustomerDetailOrder {
  id: string;
  status: string;
  totalCents: number;
  currency: string;
  createdAt: Date;
  event: { title: string };
  tickets: { id: string; code: string; checkedIn: boolean }[];
}

export interface CustomerDetailWallet {
  id: string;
  code: string;
  balanceCents: number;
  currency: string;
  event: { title: string };
}

export interface CustomerDetailData {
  customer: { userId: string; name: string; email: string } | null;
  orders: CustomerDetailOrder[];
  wallets: CustomerDetailWallet[];
}

// No status filter — order history shows REFUNDED too (badged), same as the
// existing Attendees list at dashboard/events/[id]/page.tsx. customer: null
// when there are zero in-org orders for this userId IS the cross-org guard
// — the caller should 404 rather than leak a stranger's history. Wallets are
// fetched separately (a customer may have a wallet with zero orders, e.g. a
// top-up-only attendee) but use the identical Wallet.eventId->Event.organizationId
// scoping chain as everything else.
export async function getCustomerDetailData(organizationId: string, userId: string): Promise<CustomerDetailData> {
  const myEvents = await prisma.event.findMany({ where: { organizationId }, select: { id: true } });
  const eventIds = myEvents.map((e) => e.id);
  const orders = await prisma.order.findMany({
    where: { eventId: { in: eventIds }, userId },
    orderBy: { createdAt: "desc" },
    include: {
      event: { select: { title: true } },
      user: { select: { name: true, email: true } },
      tickets: { select: { id: true, code: true, checkedIn: true } },
    },
  });
  const wallets = await prisma.wallet.findMany({
    where: { ownerUserId: userId, eventId: { in: eventIds } },
    include: { event: { select: { title: true } } },
  });
  if (orders.length === 0 && wallets.length === 0) return { customer: null, orders: [], wallets: [] };
  const user = orders[0]?.user ?? (await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } }));
  return { customer: { userId, name: user?.name ?? "Unknown", email: user?.email ?? "" }, orders, wallets };
}

export interface LiveEventRawData {
  event: { startsAt: Date } | null;
  tickets: { checkedIn: boolean; checkedInAt: Date | null }[];
  ticketTypes: { quantityTotal: number }[];
  wallets: { balanceCents: number }[];
  walletTxs: {
    type: string;
    status: string;
    amountCents: number | null;
    createdAt: Date;
    vendorId: string | null;
    vendor: { id: string; name: string } | null;
  }[];
}

// One combined fetcher backing checkInsByHour/transactionsByVendorByHour/
// liveEventStats — same "one fetcher per dashboard's worth of data, many
// pure functions draw from it" shape as getOrganizerAnalyticsData above,
// rather than three separate queries repeating the same tickets/walletTxs
// reads. event: null when the id doesn't resolve — callers should treat
// that as "event not found," same as every other id-scoped fetcher.
export async function getLiveEventData(eventId: string): Promise<LiveEventRawData> {
  const [event, tickets, ticketTypes, wallets, walletTxs] = await Promise.all([
    prisma.event.findUnique({ where: { id: eventId }, select: { startsAt: true } }),
    prisma.ticket.findMany({
      // Allowlist, same reasoning as every other analytics ticket query —
      // a still-PENDING or PAYMENT_FAILED order's tickets aren't real
      // attendance data yet.
      where: { eventId, order: { status: { in: ["PAID", "NEEDS_REVIEW"] } } },
      select: { checkedIn: true, checkedInAt: true },
    }),
    prisma.ticketType.findMany({
      where: { eventId },
      select: { quantityTotal: true },
    }),
    prisma.wallet.findMany({
      where: { eventId },
      select: { balanceCents: true },
    }),
    prisma.walletTransaction.findMany({
      where: { wallet: { eventId } },
      select: {
        type: true,
        status: true,
        amountCents: true,
        createdAt: true,
        vendorId: true,
        vendor: { select: { id: true, name: true } },
      },
    }),
  ]);

  return { event, tickets, ticketTypes, wallets, walletTxs };
}
