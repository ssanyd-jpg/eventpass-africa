import { prisma } from "@/lib/prisma";

// Session 13 — Prisma-touching fetchers for the lead buyer's own group
// management page(s), kept out of any pure/DB-free module (same split
// analytics-data.ts/analytics.ts use) so the two stay independently
// testable. Every query here is scoped to leadUserId — a group is only
// ever visible to the person who bought it, mirroring how a buyer's own
// wallet/order pages already scope everything to their own userId.

export interface MyLedGroupSummary {
  id: string;
  name: string;
  eventId: string;
  eventTitle: string;
  totalMembers: number;
  provisionedCount: number;
  sharedWalletId: string;
  balanceCents: number;
  currency: string;
}

export async function getMyLedGroups(userId: string): Promise<MyLedGroupSummary[]> {
  const groups = await prisma.ticketGroup.findMany({
    where: { leadUserId: userId },
    include: {
      event: { select: { id: true, title: true } },
      sharedWallet: { select: { id: true, balanceCents: true, currency: true } },
      _count: { select: { tickets: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  const provisionedCounts = await Promise.all(
    groups.map((g) => prisma.ticket.count({ where: { ticketGroupId: g.id, credentials: { some: { status: "ACTIVE" } } } }))
  );
  return groups.map((g, i) => ({
    id: g.id,
    name: g.name,
    eventId: g.event.id,
    eventTitle: g.event.title,
    totalMembers: g._count.tickets,
    provisionedCount: provisionedCounts[i],
    sharedWalletId: g.sharedWallet.id,
    balanceCents: g.sharedWallet.balanceCents,
    currency: g.sharedWallet.currency,
  }));
}

export interface GroupMemberRow {
  ticketId: string;
  ticketCode: string;
  ticketTypeName: string;
  memberName: string | null;
  provisioned: boolean;
}

export interface GroupTransactionRow {
  id: string;
  type: string;
  status: string;
  amountCents: number | null;
  currency: string;
  item: string | null;
  spentByMemberName: string | null;
  vendorName: string | null;
  createdAt: Date;
}

export interface GroupDetail {
  id: string;
  name: string;
  eventId: string;
  eventTitle: string;
  sharedWalletId: string;
  balanceCents: number;
  currency: string;
  members: GroupMemberRow[];
  transactions: GroupTransactionRow[];
}

// Returns null when the group doesn't exist OR the caller isn't its lead
// buyer — both treated identically by the calling page (404), same
// discipline getCustomerDetailData uses for a cross-org lookup.
export async function getGroupDetail(groupId: string, userId: string): Promise<GroupDetail | null> {
  const group = await prisma.ticketGroup.findUnique({
    where: { id: groupId },
    include: {
      event: { select: { id: true, title: true } },
      sharedWallet: {
        select: {
          id: true,
          balanceCents: true,
          currency: true,
          transactions: {
            orderBy: { createdAt: "desc" },
            include: { vendor: { select: { name: true } } },
          },
        },
      },
      tickets: {
        include: { ticketType: { select: { name: true } }, credentials: { where: { status: "ACTIVE" } } },
      },
    },
  });
  if (!group || group.leadUserId !== userId) return null;

  return {
    id: group.id,
    name: group.name,
    eventId: group.event.id,
    eventTitle: group.event.title,
    sharedWalletId: group.sharedWallet.id,
    balanceCents: group.sharedWallet.balanceCents,
    currency: group.sharedWallet.currency,
    members: group.tickets.map((t) => ({
      ticketId: t.id,
      ticketCode: t.code,
      ticketTypeName: t.ticketType.name,
      memberName: t.groupMemberName,
      provisioned: t.credentials.length > 0,
    })),
    transactions: group.sharedWallet.transactions.map((tx) => ({
      id: tx.id,
      type: tx.type,
      status: tx.status,
      amountCents: tx.amountCents,
      currency: tx.currency,
      item: tx.item,
      spentByMemberName: tx.spentByMemberName,
      vendorName: tx.vendor?.name ?? null,
      createdAt: tx.createdAt,
    })),
  };
}
