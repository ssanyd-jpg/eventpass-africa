import { prisma } from "@/lib/prisma";

// Raw recent-activity feed for the live event dashboard — kept separate
// from analytics-data.ts (frozen this session) since this isn't a bucketed/
// aggregated analytics concept, it's individual recent events merged from
// two different tables (Ticket check-ins, WalletTransaction rows) and
// sorted together.

export interface LiveActivityEntry {
  type: "CHECK_IN" | "TOPUP" | "SALE" | "SPONSOR_TAP";
  at: Date;
  // Last 4 characters of whichever code identifies the attendee for this
  // event type — a ticket code for CHECK_IN, a wallet code for everything
  // else (a check-in has no wallet involved at all, so "wallet code" isn't
  // meaningful for it).
  codeLast4: string;
  vendorName: string | null;
  sponsorName: string | null;
  amountCents: number | null;
}

export async function getLiveActivityFeed(eventId: string, limit = 20): Promise<LiveActivityEntry[]> {
  const [checkIns, walletTxs] = await Promise.all([
    prisma.ticket.findMany({
      where: {
        eventId,
        checkedInAt: { not: null },
        // Allowlist, same reasoning as every other analytics ticket query —
        // a still-PENDING/PAYMENT_FAILED order's tickets aren't real
        // attendance data (and per handleCheckIn, couldn't have actually
        // been checked in anyway).
        order: { status: { in: ["PAID", "NEEDS_REVIEW"] } },
      },
      orderBy: { checkedInAt: "desc" },
      take: limit,
      select: { code: true, checkedInAt: true },
    }),
    prisma.walletTransaction.findMany({
      where: {
        wallet: { eventId },
        OR: [
          { type: "SPONSOR_TAP" }, // no meaningful PENDING/FAILED state — always resolves synchronously
          { type: { in: ["TOPUP", "SALE"] }, status: "COMPLETED" },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        type: true,
        createdAt: true,
        amountCents: true,
        wallet: { select: { code: true } },
        vendor: { select: { name: true } },
        sponsor: { select: { name: true } },
      },
    }),
  ]);

  const entries: LiveActivityEntry[] = [
    ...checkIns.map((t) => ({
      type: "CHECK_IN" as const,
      at: t.checkedInAt!,
      codeLast4: t.code.slice(-4),
      vendorName: null,
      sponsorName: null,
      amountCents: null,
    })),
    ...walletTxs.map((t) => ({
      type: t.type as "TOPUP" | "SALE" | "SPONSOR_TAP",
      at: t.createdAt,
      codeLast4: t.wallet.code.slice(-4),
      vendorName: t.vendor?.name ?? null,
      sponsorName: t.sponsor?.name ?? null,
      amountCents: t.amountCents,
    })),
  ];

  return entries.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}
