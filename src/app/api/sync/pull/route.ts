import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { checkAndTrackDevice } from "@/lib/device-handlers";

export async function GET(request: Request) {
  const session = await auth();

  const events = await prisma.event.findMany({
    include: {
      ticketTypes: true,
      organization: { select: { name: true } },
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
    organizationId: e.organizationId,
    organizerName: e.organization.name,
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

  if (session?.user?.id && session.user.organizationId) {
    const userId = session.user.id;
    const organizationId = session.user.organizationId;

    const deviceId = request.headers.get("X-Device-Id");
    if (deviceId) {
      const deviceCheck = await checkAndTrackDevice(
        organizationId,
        deviceId,
        userId,
        session.user.name ?? session.user.email ?? "Unknown"
      );
      if (!deviceCheck.ok) {
        return NextResponse.json({ ok: false, reason: deviceCheck.reason }, { status: 403 });
      }
    }

    const myOrders = await prisma.order.findMany({
      where: {
        OR: [{ userId }, { event: { organizationId } }],
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
      where: { OR: [{ ownerUserId: userId }, { event: { organizationId } }] },
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

    const mySponsors = await prisma.sponsor.findMany({
      where: { event: { organizationId } },
      include: { event: { select: { id: true, clientId: true } } },
      orderBy: { createdAt: "desc" },
    });
    payload.mySponsors = mySponsors.map((s) => ({
      id: s.id,
      clientId: s.clientId,
      eventId: s.eventId,
      eventClientId: s.event.clientId,
      name: s.name,
      tier: s.tier,
      description: s.description,
      contactEmail: s.contactEmail,
      contactPhone: s.contactPhone,
      feeCents: s.feeCents,
      currency: s.currency,
      feeStatus: s.feeStatus,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    }));

    const myWallets = await prisma.wallet.findMany({
      where: { OR: [{ ownerUserId: userId }, { event: { organizationId } }] },
      include: { event: { select: { id: true, clientId: true } } },
      orderBy: { createdAt: "desc" },
    });
    payload.myWallets = myWallets.map((w) => ({
      id: w.id,
      clientId: w.clientId,
      code: w.code,
      eventId: w.eventId,
      eventClientId: w.event.clientId,
      ownerUserId: w.ownerUserId,
      balanceCents: w.balanceCents,
      currency: w.currency,
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
    }));

    const myWalletTransactions = await prisma.walletTransaction.findMany({
      where: { wallet: { OR: [{ ownerUserId: userId }, { event: { organizationId } }] } },
      include: { vendor: { select: { name: true } }, sponsor: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    });
    payload.myWalletTransactions = myWalletTransactions.map((t) => ({
      id: t.id,
      clientId: t.clientId,
      walletId: t.walletId,
      type: t.type,
      status: t.status,
      amountCents: t.amountCents,
      currency: t.currency,
      providerReference: t.providerReference,
      providerMessage: t.providerMessage,
      phoneNumber: t.phoneNumber,
      vendorId: t.vendorId,
      vendorName: t.vendor?.name ?? null,
      sponsorId: t.sponsorId,
      sponsorName: t.sponsor?.name ?? null,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    }));

    const accounts = await prisma.mobileMoneyAccount.findMany({
      where: { organizationId },
    });
    payload.mobileMoneyAccounts = accounts.map((a) => ({
      id: a.id,
      clientId: a.id,
      provider: a.provider,
      phoneNumber: a.phoneNumber,
      accountName: a.accountName,
      isDefault: a.isDefault,
      organizationId: a.organizationId,
    }));

    const settlements = await prisma.settlement.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
    });
    payload.settlements = settlements.map((s) => ({
      id: s.id,
      organizationId: s.organizationId,
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
