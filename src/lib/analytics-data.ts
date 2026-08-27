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
      where: { eventId: { in: eventIds }, order: { status: { not: "REFUNDED" } } },
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
        where: { order: { status: { not: "REFUNDED" } } },
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
