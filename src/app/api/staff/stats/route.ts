/**
 * GET /api/staff/stats?eventId=<id>
 *
 * Live event dashboard stats for the organiser tab in the staff app.
 * Returns attendance figures, cashless revenue, and top vendors.
 * Requires a valid staff Bearer JWT (OWNER or STAFF role).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyStaffToken, extractBearerToken } from "@/lib/staff-token";

export async function GET(request: Request) {
  const rawToken = extractBearerToken(request.headers.get("authorization"));
  if (!rawToken) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let claims;
  try {
    claims = await verifyStaffToken(rawToken);
  } catch {
    return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 });
  }

  // Dashboard is for organiser-level roles; gate crew only needs the scan tab
  if (claims.role === "GATE_CREW") {
    return NextResponse.json({ error: "Insufficient role" }, { status: 403 });
  }

  const eventId = new URL(request.url).searchParams.get("eventId") ?? claims.eventId;

  if (eventId !== claims.eventId) {
    return NextResponse.json({ error: "Token is not valid for this event" }, { status: 403 });
  }

  const [checkedInCount, totalTickets, saleTxns, vendors] = await Promise.all([
    // Attendance
    prisma.ticket.count({ where: { eventId, checkedIn: true } }),
    prisma.ticket.count({ where: { eventId } }),

    // Cashless revenue — COMPLETED SALE transactions for this event's wallets
    prisma.walletTransaction.findMany({
      where: {
        type: "SALE",
        status: "COMPLETED",
        wallet: { eventId },
      },
      select: { amountCents: true, vendorId: true },
    }),

    // Vendor list for names
    prisma.vendor.findMany({
      where: { eventId, status: "APPROVED" },
      select: { id: true, name: true },
    }),
  ]);

  const cashlessRevenueCents = saleTxns.reduce((sum: number, t: { amountCents: number | null }) => sum + (t.amountCents ?? 0), 0);
  const activeVendors = vendors.length;

  // Revenue per vendor
  const revenueByVendor: Record<string, number> = {};
  for (const tx of saleTxns) {
    if (tx.vendorId) {
      revenueByVendor[tx.vendorId] = (revenueByVendor[tx.vendorId] ?? 0) + (tx.amountCents ?? 0);
    }
  }

  const topVendors = vendors
    .map((v: { id: string; name: string }) => ({ name: v.name, revenueCents: revenueByVendor[v.id] ?? 0 }))
    .sort((a: { revenueCents: number }, b: { revenueCents: number }) => b.revenueCents - a.revenueCents)
    .slice(0, 5);

  return NextResponse.json({
    checkedIn: checkedInCount,
    totalTickets,
    cashlessRevenueCents,
    activeVendors,
    topVendors,
    lastUpdated: new Date().toISOString(),
  });
}
