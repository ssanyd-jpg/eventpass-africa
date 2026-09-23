import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { checkAndTrackDevice } from "@/lib/device-handlers";
import { getPendingSurveysForBuyer } from "@/lib/survey-handlers";
import { getRecommendedEventIdsForBuyer } from "@/lib/recommendations";
import { logIfSlow } from "@/lib/perf-log";

// Session 22 — every table below except the five explicitly marked
// "full-replace" (pendingSurveys, recommendedEventIds, credentials,
// myTimingPoints, myConferenceSessions — see pullFromServer's own comments
// for why those need shrink-capable reconciliation) is already merged
// client-side via bulkPut/upsert-by-clientId, never a wholesale replace.
// That means it's safe to hand back only what changed since the client's
// last successful pull instead of the organization's/platform's entire
// history every ~20s: nothing already in Dexie ever needs to be removed by
// this route, only added to or overwritten. `since`/`sinceAuth` are
// optional — omitted (first pull, or an old client) falls back to the
// exact unfiltered queries this route always ran, so nothing about a
// first sync changes.
// Grep-verified: no `prisma.<model>.delete` call site exists for any of
// Event/Order/Vendor/Sponsor/SponsorCampaign/DiscountCode/SurveyQuestion/
// Wallet/WalletTransaction — every one of them is soft-stated (status/
// active flags) or simply immutable once created, which is what makes
// dropping the "give me everything" guarantee safe here.
//
// TWO separate cursors, not one — this is deliberate, not an oversight.
// The public `events` query runs on every request, logged in or not;
// the whole block below it only ever runs when a session exists. An
// anonymous pull (the page loads before the buyer/organizer has logged
// in — the normal case for every page on this site) would otherwise set
// ONE shared cursor that the very next, now-authenticated pull would then
// reuse to delta-filter myOrders/myVendors/myWallets/etc. — fields that
// have never actually been fetched for this session at all, silently
// dropping everything with an updatedAt older than that stray anonymous
// timestamp forever. `sinceAuth` only ever advances from a response that
// actually included the authenticated block, so the first pull after
// logging in (or the first pull ever, or the first pull after switching
// accounts in the same browser) is always a full, unfiltered fetch of
// that block, exactly like before delta sync existed.
function parseTimestampParam(request: Request, name: string): Date | null {
  const raw = new URL(request.url).searchParams.get(name);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  const session = await auth();
  const since = parseTimestampParam(request, "since");
  // Captured before any query below runs (not after) so the next pull's
  // `since` can never be later than the moment these queries actually read
  // the database — a row written mid-request has an updatedAt at or after
  // this timestamp, so worst case it's harmlessly re-delivered (and
  // re-upserted) on the very next pull rather than silently skipped.
  const requestStartedAt = new Date();

  const events = await prisma.event.findMany({
    // Widened past a plain Event.updatedAt check: quantitySold increments on
    // every ticket sale, touching TicketType.updatedAt, never Event's own —
    // a plain filter would let the public browse/checkout page's "X left"
    // count silently go stale under delta sync. Re-including the whole
    // event on ANY of its ticket types changing is a deliberately generous
    // (occasionally redundant, never wrong) trigger.
    where: since
      ? { OR: [{ updatedAt: { gt: since } }, { ticketTypes: { some: { updatedAt: { gt: since } } } }] }
      : undefined,
    include: {
      ticketTypes: { include: { pricingTiers: true } },
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
    endsAt: e.endsAt ? e.endsAt.toISOString() : null,
    imageUrl: e.imageUrl,
    status: e.status,
    currency: e.currency,
    carryOverEnabled: e.carryOverEnabled,
    eventType: e.eventType,
    gunStartAt: e.gunStartAt ? e.gunStartAt.toISOString() : null,
    vendorApplicationsOpen: e.vendorApplicationsOpen,
    vendorStallFeeCents: e.vendorStallFeeCents,
    waitlistEnabled: e.waitlistEnabled,
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
      isFastTrack: tt.isFastTrack,
      pricingStrategy: tt.pricingStrategy,
      pricingTiers: tt.pricingTiers.map((pt) => ({
        id: pt.id,
        clientId: pt.clientId,
        label: pt.label,
        fromQuantity: pt.fromQuantity,
        priceCents: pt.priceCents,
      })),
      physicalCapacity: tt.physicalCapacity,
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
    now: requestStartedAt.toISOString(),
    events: shapedEvents,
  };

  if (session?.user?.id && session.user.organizationId) {
    const userId = session.user.id;
    const organizationId = session.user.organizationId;
    // Separate cursor from `since` above — see this file's header comment
    // for why reusing the public `events` cursor here would be wrong.
    const sinceAuth = parseTimestampParam(request, "sinceAuth");

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
        AND: [
          // Third arm: an order the caller doesn't own or organize, but
          // holds at least one ticket in via an ACCEPTED TicketTransfer —
          // see Ticket.currentHolderUserId. Pulls the WHOLE parent order
          // (all its tickets/total), not just the transferred ticket — an
          // accepted v1 simplification, same as OrderConfirmation's
          // rendering. (Deliberately AND-combined with the delta clause
          // below, not a second sibling OR key, which JS object spread
          // would silently let clobber this one.)
          { OR: [{ userId }, { event: { organizationId } }, { tickets: { some: { currentHolderUserId: userId } } }] },
          // Widened past a plain Order.updatedAt check: handleCheckIn only
          // ever updates the Ticket row (checkedIn/checkedInAt), and
          // acceptTicketTransfer only ever updates Ticket.currentHolderUserId
          // — neither touches the parent Order. A plain filter would let a
          // check-in performed on one device (or a just-accepted transfer)
          // silently never reach another device's delta pull, since the
          // order this ticket belongs to might not itself change again for
          // the rest of the event. Re-including the whole order on ANY of
          // its tickets changing matches what a full sync always returned.
          ...(sinceAuth
            ? [{ OR: [{ updatedAt: { gt: sinceAuth } }, { tickets: { some: { updatedAt: { gt: sinceAuth } } } }] }]
            : []),
        ],
      },
      include: {
        items: { include: { ticketType: true } },
        tickets: { include: { ticketType: true, ticketGroup: { select: { name: true } } } },
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
      updatedAt: o.updatedAt.toISOString(),
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
        isFastTrack: t.ticketType.isFastTrack,
        checkedIn: t.checkedIn,
        checkedInAt: t.checkedInAt ? t.checkedInAt.toISOString() : null,
        currentHolderUserId: t.currentHolderUserId ?? null,
        ticketGroupId: t.ticketGroupId ?? null,
        ticketGroupName: t.ticketGroup?.name ?? null,
        groupMemberName: t.groupMemberName ?? null,
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
      providerReference: o.providerReference ?? null,
      providerMessage: o.providerMessage ?? null,
      paymentMethod: o.paymentMethod ?? null,
    }));

    const myVendors = await prisma.vendor.findMany({
      where: {
        OR: [{ ownerUserId: userId }, { event: { organizationId } }],
        ...(sinceAuth ? { updatedAt: { gt: sinceAuth } } : {}),
      },
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
      settlementStatus: v.settlementStatus,
      settlementAmountCents: v.settlementAmountCents,
      settlementProcessedAt: v.settlementProcessedAt ? v.settlementProcessedAt.toISOString() : null,
      createdAt: v.createdAt.toISOString(),
      updatedAt: v.updatedAt.toISOString(),
    }));

    const mySponsors = await prisma.sponsor.findMany({
      where: { event: { organizationId }, ...(sinceAuth ? { updatedAt: { gt: sinceAuth } } : {}) },
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
      where: { sponsor: { event: { organizationId } }, ...(sinceAuth ? { updatedAt: { gt: sinceAuth } } : {}) },
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
      where: { event: { organizationId }, ...(sinceAuth ? { updatedAt: { gt: sinceAuth } } : {}) },
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
      where: { event: { organizationId }, ...(sinceAuth ? { updatedAt: { gt: sinceAuth } } : {}) },
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
      where: {
        OR: [{ ownerUserId: userId }, { event: { organizationId } }],
        ...(sinceAuth ? { updatedAt: { gt: sinceAuth } } : {}),
      },
      include: {
        event: { select: { id: true, clientId: true } },
        owner: { select: { name: true, email: true } },
        ticketGroup: { select: { name: true } },
      },
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
      carryOverSourceWalletId: w.carryOverSourceWalletId ?? null,
      carryOverredAt: w.carryOverredAt ? w.carryOverredAt.toISOString() : null,
      isGroupWallet: w.isGroupWallet,
      groupName: w.ticketGroup?.name ?? null,
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
    }));

    const myWalletTransactions = await prisma.walletTransaction.findMany({
      where: {
        wallet: { OR: [{ ownerUserId: userId }, { event: { organizationId } }] },
        ...(sinceAuth ? { updatedAt: { gt: sinceAuth } } : {}),
      },
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
      spentByTicketId: t.spentByTicketId ?? null,
      spentByMemberName: t.spentByMemberName ?? null,
      vendorId: t.vendorId,
      vendorName: t.vendor?.name ?? null,
      sponsorId: t.sponsorId,
      sponsorName: t.sponsor?.name ?? null,
      campaignId: t.campaignId,
      campaignName: t.campaign?.name ?? null,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    }));

    // Session 28 — vendor terminal Direct Sale. Scoped the same way
    // myWalletTransactions is (either the acting staff member's own rows, or
    // any row on an event this caller's org owns), so every terminal at the
    // event sees every direct sale, not just the ones this device rang up.
    const myDirectSaleTransactions = await prisma.directSaleTransaction.findMany({
      where: {
        OR: [{ vendorUserId: userId }, { event: { organizationId } }],
        ...(sinceAuth ? { updatedAt: { gt: sinceAuth } } : {}),
      },
      orderBy: { createdAt: "desc" },
    });
    payload.myDirectSaleTransactions = myDirectSaleTransactions.map((t) => ({
      id: t.id,
      clientId: t.clientId,
      eventId: t.eventId,
      vendorUserId: t.vendorUserId,
      amountCents: t.amountCents,
      currency: t.currency,
      customerPhone: t.customerPhone,
      mobileNetwork: t.mobileNetwork,
      airpayRef: t.airpayRef,
      providerReference: t.providerReference,
      providerMessage: t.providerMessage,
      status: t.status,
      item: t.item,
      createdAt: t.createdAt.toISOString(),
      resolvedAt: t.resolvedAt ? t.resolvedAt.toISOString() : null,
    }));

    // Session 12 — a marathon's course layout. Organiser/scanning-staff
    // scoped, same reasoning as myVendors/myWallets above: the timing
    // scanner and dashboard both need it, but it never rides in the public
    // `events` field (the public leaderboard is its own unauthenticated
    // route with its own data fetch, not Dexie-backed).
    const myTimingPoints = await prisma.timingPoint.findMany({
      where: { event: { organizationId } },
      include: { event: { select: { id: true, clientId: true } } },
      orderBy: [{ eventId: "asc" }, { sequenceOrder: "asc" }],
    });
    payload.myTimingPoints = myTimingPoints.map((p) => ({
      id: p.id,
      clientId: p.clientId,
      eventId: p.eventId,
      eventClientId: p.event.clientId,
      name: p.name,
      location: p.location,
      sequenceOrder: p.sequenceOrder,
      isStart: p.isStart,
      isFinish: p.isFinish,
      distanceMeters: p.distanceMeters,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    }));

    // Session 19 — a CONFERENCE event's session schedule, same
    // organiser/staff-scoped, synced-everywhere-read-only shape as
    // myTimingPoints above. attendanceCount is a live server-side aggregate
    // (every device's synced taps, not just the pulling device's own) so the
    // session scanner's "attendees in the room" count reflects the whole
    // room, refreshed on the same pull cadence as everything else here.
    const myConferenceSessions = await prisma.conferenceSession.findMany({
      where: { event: { organizationId } },
      include: { event: { select: { id: true, clientId: true } }, _count: { select: { attendances: true } } },
      orderBy: [{ eventId: "asc" }, { startsAt: "asc" }],
    });
    payload.myConferenceSessions = myConferenceSessions.map((s) => ({
      id: s.id,
      clientId: s.clientId,
      eventId: s.eventId,
      eventClientId: s.event.clientId,
      name: s.name,
      speaker: s.speaker,
      location: s.location,
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
      attendanceCount: s._count.attendances,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
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

    // NFC wristband resolution data — staff-only, never buyer-visible (same
    // organizationId-only scoping as mobileMoneyAccounts/settlements above,
    // not the buyer+organizer OR pattern myOrders/myWallets use). Actually
    // NFC-linked only — a plain code-replacement row (see
    // credential-handlers.ts) has no nfcUid and is irrelevant here.
    //
    // Deliberately NOT status:"ACTIVE"-only (unlike the original shipped
    // version) — a gate/wallet terminal needs to see a recently-SUPERSEDED
    // row too, to tell "this exact wristband was replaced, see the
    // registration desk" apart from "never provisioned at all" (see
    // isUidSuperseded in credentials.ts). Accepted tradeoff: this table now
    // accumulates one historical row per past replacement/re-provision,
    // same as the server's own Credential table already does — never
    // pruned, by design, for the audit trail.
    const credentials = await prisma.credential.findMany({
      where: { organizationId, nfcUid: { not: null } },
      select: {
        id: true,
        nfcUid: true,
        status: true,
        ticketId: true,
        walletId: true,
        code: true,
        createdAt: true,
        supersededAt: true,
      },
    });
    payload.credentials = credentials.map((c) => ({
      ...c,
      createdAt: c.createdAt.toISOString(),
      supersededAt: c.supersededAt ? c.supersededAt.toISOString() : null,
    }));
  }

  logIfSlow(since ? "GET /api/sync/pull (delta)" : "GET /api/sync/pull (full)", startedAt);

  return NextResponse.json(payload);
}
