import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { checkAndTrackDevice } from "@/lib/device-handlers";
import { getPendingSurveysForBuyer } from "@/lib/survey-handlers";
import { getRecommendedEventIdsForBuyer } from "@/lib/recommendations";

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
      registrationQuestions: { orderBy: { sortOrder: "asc" } },
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
    waiverText: e.waiverText ?? null,
    registrationQuestions: e.registrationQuestions.map((q) => ({
      id: q.id,
      clientId: q.clientId,
      label: q.label,
      type: q.type,
      options: q.options,
      required: q.required,
      sortOrder: q.sortOrder,
    })),
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
        // Third arm: an order the caller doesn't own or organize, but holds
        // at least one ticket in via an ACCEPTED TicketTransfer — see
        // Ticket.currentHolderUserId. Pulls the WHOLE parent order (all its
        // tickets/total), not just the transferred ticket — an accepted v1
        // simplification, same as OrderConfirmation's rendering.
        OR: [{ userId }, { event: { organizationId } }, { tickets: { some: { currentHolderUserId: userId } } }],
      },
      include: {
        items: { include: { ticketType: true } },
        tickets: { include: { ticketType: true } },
        event: { select: { id: true, clientId: true, title: true } },
        registrationAnswers: { include: { question: true } },
        user: { select: { createdAt: true } },
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
      userCreatedAt: o.user.createdAt.toISOString(),
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
        currentHolderUserId: t.currentHolderUserId ?? null,
      })),
      waiverText: o.waiverText ?? null,
      waiverAcceptedAt: o.waiverAcceptedAt ? o.waiverAcceptedAt.toISOString() : null,
      answers: o.registrationAnswers.map((a) => ({
        questionId: a.questionId,
        questionLabel: a.question.label,
        value: a.value,
      })),
      discountCents: o.discountCents ?? 0,
      discountCode: o.discountCodeText ?? null,
      discountTicketTypeName: o.discountTicketTypeName ?? null,
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

    // Organizer-only, same reasoning as myDiscountCodes below — a
    // sponsor's coupon/campaign codes never ride in the public `events`
    // field, so an anonymous browser can't enumerate them.
    const myCampaigns = await prisma.sponsorCampaign.findMany({
      where: { sponsor: { event: { organizationId } } },
      orderBy: { createdAt: "desc" },
    });
    payload.myCampaigns = myCampaigns.map((c) => ({
      id: c.id,
      clientId: c.clientId,
      sponsorId: c.sponsorId,
      name: c.name,
      code: c.code,
      maxRedemptions: c.maxRedemptions,
      redemptionCount: c.redemptionCount,
      expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
      active: c.active,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }));

    // Organizer-only, unlike ticketTypes: discount codes deliberately do NOT
    // ride in the public `events` field above — anyone browsing an event
    // could otherwise enumerate its promo codes straight out of an
    // anonymous browser's IndexedDB. Scoped to the organizing org only,
    // same as mySponsors.
    const myDiscountCodes = await prisma.discountCode.findMany({
      where: { event: { organizationId } },
      include: { ticketType: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    });
    payload.myDiscountCodes = myDiscountCodes.map((dc) => ({
      id: dc.id,
      clientId: dc.clientId,
      eventId: dc.eventId,
      code: dc.code,
      type: dc.type,
      percentOff: dc.percentOff,
      amountOffCents: dc.amountOffCents,
      ticketTypeId: dc.ticketTypeId,
      ticketTypeName: dc.ticketType.name,
      maxRedemptions: dc.maxRedemptions,
      redemptionCount: dc.redemptionCount,
      expiresAt: dc.expiresAt ? dc.expiresAt.toISOString() : null,
      active: dc.active,
      createdAt: dc.createdAt.toISOString(),
      updatedAt: dc.updatedAt.toISOString(),
    }));

    // Organizer-only, same reasoning as myDiscountCodes — survey questions
    // are never needed pre-purchase, so they don't ride in the public
    // `events` field above.
    const mySurveyQuestions = await prisma.surveyQuestion.findMany({
      where: { event: { organizationId } },
      orderBy: { sortOrder: "asc" },
    });
    payload.mySurveyQuestions = mySurveyQuestions.map((q) => ({
      id: q.id,
      clientId: q.clientId,
      eventId: q.eventId,
      label: q.label,
      type: q.type,
      options: q.options,
      required: q.required,
      sortOrder: q.sortOrder,
      createdAt: q.createdAt.toISOString(),
      updatedAt: q.updatedAt.toISOString(),
    }));

    // Lazy survey-invitation trigger — extracted to survey-handlers.ts for
    // direct testability. See getPendingSurveysForBuyer's own comment for
    // why this piggybacks on the pull poll instead of a real scheduler.
    payload.pendingSurveys = await getPendingSurveysForBuyer(userId);

    // Deterministic same-category recommendations — see recommendations.ts's
    // own header comment for why only ids ride here (full event shapes
    // already ride in the unconditional `events` field above).
    payload.recommendedEventIds = await getRecommendedEventIdsForBuyer(userId);

    const myWallets = await prisma.wallet.findMany({
      where: { OR: [{ ownerUserId: userId }, { event: { organizationId } }] },
      include: { event: { select: { id: true, clientId: true } }, owner: { select: { name: true, email: true } } },
      orderBy: { createdAt: "desc" },
    });
    payload.myWallets = myWallets.map((w) => ({
      id: w.id,
      clientId: w.clientId,
      code: w.code,
      eventId: w.eventId,
      eventClientId: w.event.clientId,
      ownerUserId: w.ownerUserId,
      ownerName: w.owner.name,
      ownerEmail: w.owner.email,
      balanceCents: w.balanceCents,
      currency: w.currency,
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
    }));

    const myWalletTransactions = await prisma.walletTransaction.findMany({
      where: { wallet: { OR: [{ ownerUserId: userId }, { event: { organizationId } }] } },
      include: {
        vendor: { select: { name: true } },
        sponsor: { select: { name: true } },
        campaign: { select: { name: true } },
      },
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
      mobileNetwork: t.mobileNetwork,
      note: t.note ?? null,
      vendorId: t.vendorId,
      vendorName: t.vendor?.name ?? null,
      sponsorId: t.sponsorId,
      sponsorName: t.sponsor?.name ?? null,
      campaignId: t.campaignId,
      campaignName: t.campaign?.name ?? null,
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
