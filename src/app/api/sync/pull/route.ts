import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();

  const events = await prisma.event.findMany({
    include: {
      ticketTypes: true,
      organizer: { select: { name: true } },
      // Public summary only — no contact info/badgeCode. Full vendor
      // detail (all statuses) goes out separately in myVendors below,
      // gated to the vendor's own owner or the event's organizer.
      vendors: { where: { status: "APPROVED" }, select: { id: true, name: true, category: true, boothNumber: true } },
    },
    orderBy: { startsAt: "asc" },
  });

  const shapedEvents = events.map((e) => ({
    id: e.id,
    clientId: e.clientId,
    slug: e.slug,
    title: e.title,
    description: e.description,
    category: e.category,
    venue: e.venue,
    city: e.city,
    startsAt: e.startsAt.toISOString(),
    imageUrl: e.imageUrl,
    status: e.status,
    currency: e.currency,
    vendorApplicationsOpen: e.vendorApplicationsOpen,
    vendorStallFeeCents: e.vendorStallFeeCents,
    organizerId: e.organizerId,
    organizerName: e.organizer.name,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    ticketTypes: e.ticketTypes.map((tt) => ({
      id: tt.id,
      clientId: tt.clientId,
      name: tt.name,
      description: tt.description,
      priceCents: tt.priceCents,
      quantityTotal: tt.quantityTotal,
      quantitySold: tt.quantitySold,
    })),
    vendors: e.vendors,
  }));

  const payload: Record<string, unknown> = {
    now: new Date().toISOString(),
    events: shapedEvents,
  };

  if (session?.user?.id) {
    const userId = session.user.id;

    const myOrders = await prisma.order.findMany({
      where: {
        OR: [{ userId }, { event: { organizerId: userId } }],
      },
      include: {
        items: { include: { ticketType: true } },
        tickets: { include: { ticketType: true } },
        event: { select: { id: true, clientId: true, title: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    payload.myOrders = myOrders.map((o) => ({
      id: o.id,
      clientId: o.clientId,
      status: o.status,
      totalCents: o.totalCents,
      currency: o.currency,
      createdAt: o.createdAt.toISOString(),
      userId: o.userId,
      eventId: o.eventId,
      eventClientId: o.event.clientId,
      eventTitle: o.event.title,
      items: o.items.map((i) => ({
        ticketTypeId: i.ticketTypeId,
        ticketTypeName: i.ticketType.name,
        quantity: i.quantity,
        unitPriceCents: i.unitPriceCents,
      })),
      tickets: o.tickets.map((t) => ({
        id: t.id,
        clientId: t.clientId,
        code: t.code,
        ticketTypeId: t.ticketTypeId,
        ticketTypeName: t.ticketType.name,
        checkedIn: t.checkedIn,
        checkedInAt: t.checkedInAt ? t.checkedInAt.toISOString() : null,
      })),
    }));

    const myVendors = await prisma.vendor.findMany({
      where: { OR: [{ ownerUserId: userId }, { event: { organizerId: userId } }] },
      include: { event: { select: { id: true, clientId: true } } },
      orderBy: { createdAt: "desc" },
    });
    payload.myVendors = myVendors.map((v) => ({
      id: v.id,
      clientId: v.clientId,
      eventId: v.eventId,
      eventClientId: v.event.clientId,
      name: v.name,
      category: v.category,
      description: v.description,
      contactEmail: v.contactEmail,
      contactPhone: v.contactPhone,
      status: v.status,
      boothNumber: v.boothNumber,
      stallFeeCents: v.stallFeeCents,
      currency: v.currency,
      feeStatus: v.feeStatus,
      ownerUserId: v.ownerUserId,
      badgeCode: v.badgeCode,
      checkedIn: v.checkedIn,
      checkedInAt: v.checkedInAt ? v.checkedInAt.toISOString() : null,
      createdAt: v.createdAt.toISOString(),
      updatedAt: v.updatedAt.toISOString(),
    }));

    const accounts = await prisma.mobileMoneyAccount.findMany({
      where: { organizerId: userId },
    });
    payload.mobileMoneyAccounts = accounts.map((a) => ({
      id: a.id,
      clientId: a.id,
      provider: a.provider,
      phoneNumber: a.phoneNumber,
      accountName: a.accountName,
      isDefault: a.isDefault,
      organizerId: a.organizerId,
    }));

    const settlements = await prisma.settlement.findMany({
      where: { organizerId: userId },
      orderBy: { createdAt: "desc" },
    });
    payload.settlements = settlements.map((s) => ({
      id: s.id,
      organizerId: s.organizerId,
      mobileMoneyAccountId: s.mobileMoneyAccountId,
      periodStart: s.periodStart.toISOString(),
      periodEnd: s.periodEnd.toISOString(),
      currency: s.currency,
      grossCents: s.grossCents,
      platformFeeCents: s.platformFeeCents,
      netCents: s.netCents,
      status: s.status,
      payoutReference: s.payoutReference,
      createdAt: s.createdAt.toISOString(),
      paidAt: s.paidAt ? s.paidAt.toISOString() : null,
    }));
  }

  return NextResponse.json(payload);
}
