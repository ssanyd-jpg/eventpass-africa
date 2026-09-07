import crypto from "crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { generateTicketCode, slugify, formatCents } from "@/lib/format";
import { sendNotification } from "@/lib/notifications";
import { CURRENCY_CODES, DEFAULT_CURRENCY } from "@/lib/currency";
import { getActivePaymentProvider } from "@/lib/payments";
import { verifyAirpayOrder } from "@/lib/payments/airpay";

// Core business logic behind POST /api/sync/push, extracted out of the
// route file so it can be exercised directly in tests without going
// through HTTP/session plumbing (Next.js route files may only export
// recognized route handlers, e.g. GET/POST, not arbitrary helpers).

const ticketTypeInputSchema = z.object({
  clientId: z.string().min(1),
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  priceCents: z.number().int().min(0),
  quantityTotal: z.number().int().min(1),
});

export const VENDOR_CATEGORIES = ["Food", "Merchandise", "Services", "Other"] as const;
export const SPONSOR_TIERS = ["Platinum", "Gold", "Silver", "Bronze", "Other"] as const;
export const REGISTRATION_QUESTION_TYPES = ["TEXT", "SELECT", "CHECKBOX"] as const;
export const DISCOUNT_TYPES = ["PERCENT_OFF", "FIXED_AMOUNT_OFF"] as const;

const registrationQuestionInputSchema = z.object({
  id: z.string().optional(),
  clientId: z.string().min(1),
  label: z.string().min(1).max(200),
  type: z.enum(REGISTRATION_QUESTION_TYPES),
  options: z.string().max(1000).optional(),
  required: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

// ticketTypeId may reference a real, already-persisted TicketType.id, OR
// (when a code is created in the same save as the ticket type it applies
// to) that ticket type's clientId — handleEditEvent resolves this after its
// ticketTypes upsert loop runs. See the cross-reference-resolution note there.
const discountCodeInputSchema = z.object({
  id: z.string().optional(),
  clientId: z.string().min(1),
  code: z.string().min(3).max(20),
  type: z.enum(DISCOUNT_TYPES),
  ticketTypeId: z.string().min(1),
  percentOff: z.number().int().min(1).max(100).optional(),
  amountOffCents: z.number().int().min(1).optional(),
  maxRedemptions: z.number().int().min(1).optional(),
  expiresAt: z.string().optional(),
  active: z.boolean().optional(),
});

export const payloadSchemas = {
  CREATE_EVENT: z.object({
    eventId: z.string().min(1),
    title: z.string().min(1).max(120),
    description: z.string().max(4000).optional(),
    category: z.string().min(1).max(40),
    venue: z.string().min(1).max(120),
    city: z.string().min(1).max(120),
    startsAt: z.string().min(1),
    imageUrl: z.string().min(1),
    currency: z.enum(CURRENCY_CODES).optional(),
    ticketTypes: z.array(ticketTypeInputSchema).min(1),
  }),
  SELL_TICKETS: z.object({
    clientId: z.string().min(1),
    eventId: z.string().min(1),
    eventClientId: z.string().nullable().optional(),
    items: z
      .array(
        z.object({
          ticketTypeId: z.string().min(1),
          quantity: z.number().int().min(1).max(50),
          codes: z.array(z.string().min(1).max(40)).optional(),
        })
      )
      .min(1),
    answers: z.array(z.object({ questionId: z.string().min(1), value: z.string().max(2000) })).optional(),
    waiverAccepted: z.boolean().optional(),
    // Never trusted for the actual discount math — the client can't
    // pre-validate a code offline (codes don't ride in the public event
    // pull), so this is re-looked-up and re-validated server-side inside
    // handleSellTickets. An invalid/inapplicable code never blocks the
    // sale — see the soft-fail discount block below.
    discountCode: z.string().max(40).optional(),
    // Omitted entirely = legacy/pre-payment-feature behavior: no charge
    // attempt, instant PAID/NEEDS_REVIEW exactly as before this field
    // existed. AIRPAY_ONLINE requires a phoneNumber (can't STK-push without
    // one); mobileNetwork stays optional like TOPUP_WALLET's, since Airpay
    // itself defaults an unset network to MPESA.
    paymentMethod: z.enum(["AIRPAY_ONLINE", "OFFLINE_DEFERRED"]).optional(),
    phoneNumber: z.string().min(6).max(20).optional(),
    mobileNetwork: z.enum(["MPESA", "TIGO", "AIRTEL", "HALOTEL"]).optional(),
  }).superRefine((val, ctx) => {
    if (val.paymentMethod === "AIRPAY_ONLINE" && !val.phoneNumber) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["phoneNumber"], message: "phoneNumber is required for AIRPAY_ONLINE." });
    }
  }),
  CHECK_IN: z.object({
    clientId: z.string().min(1),
    ticketCode: z.string().min(1).max(40),
    eventId: z.string().min(1),
    scannedAt: z.string().optional(),
  }),
  ADD_MOBILE_MONEY_ACCOUNT: z.object({
    clientId: z.string().min(1),
    provider: z.enum(["MPESA_TZ", "TIGO_PESA", "AIRTEL_MONEY", "HALOPESA"]),
    phoneNumber: z.string().min(6).max(20),
    accountName: z.string().min(1).max(120),
  }),
  EDIT_EVENT: z.object({
    eventId: z.string().min(1),
    eventClientId: z.string().nullable().optional(),
    title: z.string().min(1).max(120).optional(),
    description: z.string().max(4000).optional(),
    category: z.string().min(1).max(40).optional(),
    venue: z.string().min(1).max(120).optional(),
    city: z.string().min(1).max(120).optional(),
    startsAt: z.string().min(1).optional(),
    imageUrl: z.string().min(1).optional(),
    currency: z.enum(CURRENCY_CODES).optional(),
    ticketTypes: z
      .array(
        z.object({
          id: z.string().optional(),
          clientId: z.string().min(1),
          name: z.string().min(1).max(80),
          description: z.string().max(500).optional(),
          priceCents: z.number().int().min(0),
          quantityTotal: z.number().int().min(1),
        })
      )
      .optional(),
    vendorApplicationsOpen: z.boolean().optional(),
    vendorStallFeeCents: z.number().int().min(0).optional(),
    waiverText: z.string().max(8000).nullable().optional(),
    registrationQuestions: z.array(registrationQuestionInputSchema).optional(),
    discountCodes: z.array(discountCodeInputSchema).optional(),
    // Same exact shape as registrationQuestions — post-event survey
    // questions, reusing registrationQuestionInputSchema verbatim rather
    // than duplicating it (see the SurveyQuestion schema comment).
    surveyQuestions: z.array(registrationQuestionInputSchema).optional(),
  }),
  CANCEL_EVENT: z.object({
    eventId: z.string().min(1),
    eventClientId: z.string().nullable().optional(),
  }),
  REFUND_ORDER: z.object({
    clientId: z.string().min(1),
    orderId: z.string().min(1),
    orderClientId: z.string().nullable().optional(),
  }),
  // Deliberately excludes feeStatus/stallFeeCents/currency — the server
  // derives these from the event itself rather than trusting client input,
  // same discipline SELL_TICKETS uses for totalCents.
  APPLY_VENDOR: z.object({
    clientId: z.string().min(1),
    eventId: z.string().min(1),
    eventClientId: z.string().nullable().optional(),
    name: z.string().min(1).max(120),
    category: z.enum(VENDOR_CATEGORIES),
    description: z.string().max(1000).optional(),
    contactEmail: z.string().email().max(160),
    contactPhone: z.string().min(6).max(20),
  }),
  ADD_VENDOR: z.object({
    clientId: z.string().min(1),
    eventId: z.string().min(1),
    eventClientId: z.string().nullable().optional(),
    name: z.string().min(1).max(120),
    category: z.enum(VENDOR_CATEGORIES),
    description: z.string().max(1000).optional(),
    contactEmail: z.string().email().max(160).optional(),
    contactPhone: z.string().min(6).max(20).optional(),
    boothNumber: z.string().max(20).optional(),
    badgeCode: z.string().min(1).max(40),
    feeStatus: z.enum(["NONE", "PAID"]).optional(),
  }),
  ADD_SPONSOR: z.object({
    clientId: z.string().min(1),
    eventId: z.string().min(1),
    eventClientId: z.string().nullable().optional(),
    name: z.string().min(1).max(120),
    tier: z.enum(SPONSOR_TIERS),
    description: z.string().max(1000).optional(),
    contactEmail: z.string().email().max(160).optional(),
    contactPhone: z.string().min(6).max(20).optional(),
    feeCents: z.number().int().min(0).optional(),
    feeStatus: z.enum(["NONE", "PAID"]).optional(),
  }),
  APPROVE_VENDOR: z.object({
    vendorId: z.string().min(1),
    vendorClientId: z.string().nullable().optional(),
    boothNumber: z.string().max(20).optional(),
    badgeCode: z.string().min(1).max(40),
  }),
  REJECT_VENDOR: z.object({
    vendorId: z.string().min(1),
    vendorClientId: z.string().nullable().optional(),
  }),
  CHECK_IN_VENDOR: z.object({
    clientId: z.string().min(1),
    badgeCode: z.string().min(1).max(40),
    eventId: z.string().min(1),
    scannedAt: z.string().optional(),
  }),
  CREATE_WALLET: z.object({
    clientId: z.string().min(1),
    code: z.string().min(1).max(40),
    eventId: z.string().min(1),
    eventClientId: z.string().nullable().optional(),
  }),
  // Either userId (an already-resolved attendee) or email+name (a walk-up
  // attendee with no account yet) must be present — never both trusted at
  // once, enforced below.
  PROVISION_CREDENTIAL: z.object({
    clientId: z.string().min(1),
    eventId: z.string().min(1),
    eventClientId: z.string().nullable().optional(),
    nfcUid: z.string().min(1),
    userId: z.string().min(1).optional(),
    email: z.string().email().optional(),
    name: z.string().min(1).max(120).optional(),
    // Set only when the provisioning page had to optimistically create a
    // brand-new local Wallet (no existing wallet found for this attendee) —
    // lets the new server-side Wallet row carry the same clientId that
    // local optimistic row used, so applyProvisionCredentialResult can
    // delete-then-replace it the same way applyCreateWalletResult does.
    walletClientId: z.string().min(1).optional(),
  }).superRefine((val, ctx) => {
    if (!val.userId && !(val.email && val.name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Either userId or email+name is required." });
    }
  }),
  TOPUP_WALLET: z.object({
    clientId: z.string().min(1),
    walletId: z.string().min(1),
    walletClientId: z.string().nullable().optional(),
    amountCents: z.number().int().min(100).max(50000000),
    phoneNumber: z.string().min(6).max(20).optional(),
    mobileNetwork: z.enum(["MPESA", "TIGO", "AIRTEL", "HALOTEL"]).optional(),
  }),
  CHECK_TOPUP_STATUS: z.object({
    clientId: z.string().min(1),
    walletTransactionId: z.string().min(1),
    walletTransactionClientId: z.string().nullable().optional(),
  }),
  CHECK_ORDER_PAYMENT_STATUS: z.object({
    clientId: z.string().min(1),
    orderId: z.string().min(1),
    orderClientId: z.string().nullable().optional(),
  }),
  // Unlike TOPUP_WALLET, phoneNumber/mobileNetwork are required — no real
  // disbursement API exists, so the organizer pays the buyer out manually
  // once approved, and can't do that without knowing where to send it.
  WITHDRAW_WALLET: z.object({
    clientId: z.string().min(1),
    walletId: z.string().min(1),
    walletClientId: z.string().nullable().optional(),
    amountCents: z.number().int().min(100).max(50000000),
    phoneNumber: z.string().min(6).max(20),
    mobileNetwork: z.enum(["MPESA", "TIGO", "AIRTEL", "HALOTEL"]),
  }),
  APPROVE_WITHDRAWAL: z.object({
    clientId: z.string().min(1),
    walletTransactionId: z.string().min(1),
    walletTransactionClientId: z.string().nullable().optional(),
  }),
  REJECT_WITHDRAWAL: z.object({
    clientId: z.string().min(1),
    walletTransactionId: z.string().min(1),
    walletTransactionClientId: z.string().nullable().optional(),
    reason: z.string().max(500).optional(),
  }),
  // Deliberately excludes anything currency/fee-derived — the server
  // re-derives currency from the wallet, same discipline SELL_TICKETS uses
  // for totalCents and APPLY_VENDOR uses for feeStatus.
  CHARGE_WALLET: z.object({
    clientId: z.string().min(1),
    walletCode: z.string().min(1).max(40),
    vendorId: z.string().min(1),
    vendorClientId: z.string().nullable().optional(),
    amountCents: z.number().int().min(1),
    eventId: z.string().min(1),
    eventClientId: z.string().nullable().optional(),
    scannedAt: z.string().optional(),
  }),
  SPONSOR_TAP: z.object({
    clientId: z.string().min(1),
    walletCode: z.string().min(1).max(40),
    sponsorId: z.string().min(1),
    sponsorClientId: z.string().nullable().optional(),
    eventId: z.string().min(1),
    eventClientId: z.string().nullable().optional(),
    scannedAt: z.string().optional(),
    // nullable AND optional — an already-offline-queued tap from before
    // this field existed has no `note` key at all and must still parse.
    note: z.string().trim().max(500).nullable().optional(),
    // A real SponsorCampaign id (or its clientId, for one created in the
    // same offline session) — never a typed code; the scan terminal offers
    // a dropdown of that sponsor's offline-cached campaigns.
    campaignId: z.string().nullable().optional(),
    campaignClientId: z.string().nullable().optional(),
  }),
  ADD_SPONSOR_CAMPAIGN: z.object({
    clientId: z.string().min(1),
    sponsorId: z.string().min(1),
    sponsorClientId: z.string().nullable().optional(),
    name: z.string().min(1).max(120),
    code: z.string().min(2).max(30),
    maxRedemptions: z.number().int().min(1).optional(),
    expiresAt: z.string().nullable().optional(),
  }),
  DEACTIVATE_SPONSOR_CAMPAIGN: z.object({
    clientId: z.string().min(1),
    campaignId: z.string().min(1),
    campaignClientId: z.string().nullable().optional(),
  }),
} as const;

async function resolveEventId(eventId: string, eventClientId?: string | null) {
  const byId = await prisma.event.findUnique({ where: { id: eventId } });
  if (byId) return byId;
  if (eventClientId) {
    const byClientId = await prisma.event.findUnique({ where: { clientId: eventClientId } });
    if (byClientId) return byClientId;
  }
  return null;
}

export async function handleCreateEvent(userId: string, organizationId: string, payload: any) {
  const clientId = String(payload.eventId);

  const existing = await prisma.event.findUnique({
    where: { clientId },
    include: {
      ticketTypes: true,
      organization: { select: { name: true } },
      vendors: { where: { status: "APPROVED" }, select: { id: true, name: true, category: true, boothNumber: true } },
      registrationQuestions: { orderBy: { sortOrder: "asc" } },
    },
  });
  if (existing) {
    return { ok: true, event: shapeEvent(existing, existing.organization.name) };
  }

  const baseSlug = slugify(String(payload.title));
  let slug = baseSlug;
  let n = 1;
  while (await prisma.event.findUnique({ where: { slug } })) {
    slug = `${baseSlug}-${++n}`;
  }

  const created = await prisma.event.create({
    data: {
      clientId,
      slug,
      title: String(payload.title),
      description: String(payload.description ?? ""),
      category: String(payload.category),
      venue: String(payload.venue),
      city: String(payload.city),
      startsAt: new Date(payload.startsAt),
      imageUrl: String(payload.imageUrl),
      currency: String(payload.currency ?? DEFAULT_CURRENCY),
      organizationId,
      ticketTypes: {
        create: (payload.ticketTypes as any[]).map((tt) => ({
          clientId: String(tt.clientId),
          name: String(tt.name),
          description: String(tt.description ?? ""),
          priceCents: Number(tt.priceCents),
          quantityTotal: Number(tt.quantityTotal),
        })),
      },
    },
    include: {
      ticketTypes: true,
      organization: { select: { name: true } },
      vendors: { where: { status: "APPROVED" }, select: { id: true, name: true, category: true, boothNumber: true } },
      registrationQuestions: { orderBy: { sortOrder: "asc" } },
    },
  });

  return { ok: true, event: shapeEvent(created, created.organization.name) };
}

export function shapeEvent(e: any, organizerName: string) {
  return {
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
    organizerName,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    ticketTypes: e.ticketTypes.map((tt: any) => ({
      id: tt.id,
      clientId: tt.clientId,
      name: tt.name,
      description: tt.description,
      priceCents: tt.priceCents,
      quantityTotal: tt.quantityTotal,
      quantitySold: tt.quantitySold,
    })),
    // Public summary shape only (approved vendors, no contact info) — this
    // is the same `events` Dexie table the public pull writes to, so the
    // shape must match regardless of who's asking. Full vendor detail
    // lives in the separate `vendors` table/pull field.
    vendors: (e.vendors ?? []).map((v: any) => ({
      id: v.id,
      name: v.name,
      category: v.category,
      boothNumber: v.boothNumber,
    })),
    waiverText: e.waiverText ?? null,
    registrationQuestions: (e.registrationQuestions ?? []).map((q: any) => ({
      id: q.id,
      clientId: q.clientId,
      label: q.label,
      type: q.type,
      options: q.options,
      required: q.required,
      sortOrder: q.sortOrder,
    })),
  };
}

export function shapeOrder(o: any) {
  return {
    id: o.id,
    clientId: o.clientId,
    status: o.status,
    totalCents: o.totalCents,
    currency: o.currency,
    createdAt: o.createdAt.toISOString(),
    userId: o.userId,
    eventId: o.eventId,
    eventClientId: o.event?.clientId ?? null,
    eventTitle: o.event?.title ?? "",
    items: o.items.map((i: any) => ({
      ticketTypeId: i.ticketTypeId,
      ticketTypeName: i.ticketType.name,
      quantity: i.quantity,
      unitPriceCents: i.unitPriceCents,
    })),
    tickets: o.tickets.map((t: any) => ({
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
    answers: (o.registrationAnswers ?? []).map((a: any) => ({
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
    // Set only transiently on the return value of handleSellTickets itself
    // (never persisted) — informs the buyer why a typed code didn't apply.
    // Absent on every other shapeOrder call site (pull/replay/refund),
    // which is correct: those don't have this context and shouldn't invent one.
    discountRejectReason: o.discountRejectReason ?? null,
  };
}

// Shared by handleSellTickets' idempotency lookup, its normal order.create,
// and the immediate-payment-decline branch — all three need the same shape
// for shapeOrder to work on the result.
const fullOrderInclude = {
  items: { include: { ticketType: true } },
  tickets: { include: { ticketType: true } },
  event: { select: { id: true, clientId: true, title: true } },
  registrationAnswers: { include: { question: true } },
} as const;

export async function handleSellTickets(userId: string, payload: any) {
  const clientId = String(payload.clientId);

  const existing = await prisma.order.findUnique({
    where: { clientId },
    include: fullOrderInclude,
  });
  if (existing) {
    return { ok: true, order: shapeOrder(existing), oversold: existing.status === "NEEDS_REVIEW", ticketTypeUpdates: [] };
  }

  const event = await resolveEventId(String(payload.eventId), payload.eventClientId);
  if (!event) {
    return { ok: false, retry: true, reason: "EVENT_NOT_SYNCED_YET" };
  }

  // Client-side "Continue" gating is a UX nicety only — never trust it for
  // anything that matters, same discipline as APPLY_VENDOR deriving
  // feeStatus server-side rather than trusting client input.
  if (event.waiverText && !payload.waiverAccepted) {
    return { ok: false, reason: "WAIVER_REQUIRED" };
  }

  const items = payload.items as Array<{ ticketTypeId: string; quantity: number; codes?: string[] }>;

  // AIRPAY_ONLINE charges the buyer BEFORE any inventory is touched — a
  // hard-declined charge (e.g. no phone number) must never reserve tickets.
  // Mirrors handleTopupWallet's exact ordering: initiateCharge happens
  // outside/before the inventory-mutating $transaction.
  let charge: { status: "PAID" | "PENDING" | "FAILED"; reference: string; message?: string } | null = null;
  if (payload.paymentMethod === "AIRPAY_ONLINE") {
    let precheckTotalCents = 0;
    for (const item of items) {
      const tt = await prisma.ticketType.findUnique({ where: { id: item.ticketTypeId }, select: { priceCents: true } });
      if (tt) precheckTotalCents += tt.priceCents * item.quantity;
    }

    const provider = getActivePaymentProvider();
    charge = await provider.initiateCharge({
      orderClientId: clientId,
      amountCents: precheckTotalCents,
      phoneNumber: String(payload.phoneNumber),
      mobileNetwork: payload.mobileNetwork ? String(payload.mobileNetwork) : undefined,
      description: `Tickets — ${event.title}`,
    });

    if (charge.status === "FAILED") {
      // No inventory was ever reserved — persist a terminal order anyway
      // (rather than returning ok: false with nothing saved) so the
      // buyer's optimistic local PENDING order has something real to
      // reconcile to; see applySellTicketsResult in sync-engine.ts.
      const failedOrder = await prisma.order.create({
        data: {
          clientId,
          status: "PAYMENT_FAILED",
          totalCents: precheckTotalCents,
          currency: event.currency,
          waiverText: event.waiverText ?? null,
          waiverAcceptedAt: payload.waiverAccepted ? new Date() : null,
          paymentMethod: "AIRPAY_ONLINE",
          providerReference: charge.reference || null,
          providerMessage: charge.message ?? null,
          userId,
          eventId: event.id,
        },
        include: fullOrderInclude,
      });

      const buyer = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
      if (buyer) {
        await sendNotification({
          type: "ORDER_PAYMENT_FAILED",
          channel: "EMAIL",
          recipient: buyer.email,
          subject: `Payment failed for ${event.title}`,
          body: `Hi ${buyer.name}, your mobile money payment for ${event.title} could not be completed${charge.message ? `: ${charge.message}` : "."} No tickets were issued and nothing was charged. Please try again.`,
        });
      }
      return { ok: true, order: shapeOrder(failedOrder), oversold: false, ticketTypeUpdates: [] };
    }
    // charge.status is PENDING (Airpay's real provider always returns this)
    // or PAID (the simulator, or a rare synchronous-approve) — fall through
    // into the normal inventory-reserving transaction either way.
  }

  let oversold = false;
  let totalCents = 0;
  const ticketTypeUpdates: Array<{ id: string; quantitySold: number }> = [];

  const { order, discountRejectReason } = await prisma.$transaction(async (tx) => {
    const orderItemsData: any[] = [];
    const ticketsData: any[] = [];

    for (const item of items) {
      const tt = await tx.ticketType.findUnique({ where: { id: item.ticketTypeId } });
      if (!tt) continue;

      if (tt.quantitySold + item.quantity > tt.quantityTotal) {
        oversold = true;
      }

      const updatedTt = await tx.ticketType.update({
        where: { id: tt.id },
        data: { quantitySold: { increment: item.quantity } },
      });
      ticketTypeUpdates.push({ id: updatedTt.id, quantitySold: updatedTt.quantitySold });

      totalCents += tt.priceCents * item.quantity;
      orderItemsData.push({
        ticketTypeId: tt.id,
        quantity: item.quantity,
        unitPriceCents: tt.priceCents,
      });

      for (let i = 0; i < item.quantity; i++) {
        // Reuse the buyer-visible code generated at purchase time when
        // present — falls back to generating one only for older/offline
        // clients that didn't send codes yet.
        ticketsData.push({
          code: item.codes?.[i] ?? generateTicketCode(),
          eventId: event.id,
          ticketTypeId: tt.id,
        });
      }
    }

    // Filtered against this event's real questions, defensive against a
    // stale/tampered client — mirrors the silent-skip-on-not-found behavior
    // the ticketType lookup above already applies.
    const validQuestionIds = new Set(
      (await tx.registrationQuestion.findMany({ where: { eventId: event.id }, select: { id: true } })).map((q) => q.id)
    );
    const answersData = ((payload.answers ?? []) as Array<{ questionId: string; value: string }>)
      .filter((a) => validQuestionIds.has(a.questionId))
      .map((a) => ({ questionId: a.questionId, value: String(a.value) }));

    // Discount codes are re-looked-up and re-validated entirely server-side
    // — the client can't pre-validate offline (codes deliberately don't
    // ride in the public event pull, so a browser can't enumerate an
    // organizer's promo codes). Never a hard reject: like the oversell
    // check above, an invalid/expired/exhausted/inapplicable code doesn't
    // block the sale, it just doesn't apply — the order still completes at
    // full price with a reason reported back for the buyer to see.
    const rawCode = payload.discountCode ? String(payload.discountCode).trim().toUpperCase() : null;
    let discountCents = 0;
    let discountRejectReason: string | null = null;
    let appliedDiscount: { id: string; code: string; ticketTypeName: string } | null = null;

    if (rawCode) {
      const dc = await tx.discountCode.findUnique({
        where: { eventId_code: { eventId: event.id, code: rawCode } },
        include: { ticketType: true },
      });
      const matchingItem = dc ? items.find((it) => it.ticketTypeId === dc.ticketTypeId) : undefined;

      if (!dc) discountRejectReason = "DISCOUNT_NOT_FOUND";
      else if (!dc.active) discountRejectReason = "DISCOUNT_INACTIVE";
      else if (dc.expiresAt && dc.expiresAt < new Date()) discountRejectReason = "DISCOUNT_EXPIRED";
      else if (dc.maxRedemptions != null && dc.redemptionCount >= dc.maxRedemptions) discountRejectReason = "DISCOUNT_MAX_REDEEMED";
      else if (!matchingItem) discountRejectReason = "DISCOUNT_NOT_APPLICABLE";
      else {
        // CAS on redemptionCount — same discipline as handleChargeWallet's
        // balanceCents updateMany, so two buyers racing the last redemption
        // slot can't both win.
        const res = await tx.discountCode.updateMany({
          where: {
            id: dc.id,
            active: true,
            OR: [{ maxRedemptions: null }, { redemptionCount: { lt: dc.maxRedemptions ?? 0 } }],
          },
          data: { redemptionCount: { increment: 1 } },
        });
        if (res.count === 1) {
          const lineTotalCents = dc.ticketType.priceCents * matchingItem.quantity;
          discountCents = dc.type === "PERCENT_OFF"
            ? Math.round(lineTotalCents * ((dc.percentOff ?? 0) / 100))
            : Math.min(dc.amountOffCents ?? 0, lineTotalCents);
          appliedDiscount = { id: dc.id, code: rawCode, ticketTypeName: dc.ticketType.name };
        } else {
          discountRejectReason = "DISCOUNT_MAX_REDEEMED"; // lost the race
        }
      }
    }
    const finalTotalCents = Math.max(0, totalCents - discountCents);

    // Oversold always wins as NEEDS_REVIEW regardless of payment path — that
    // pre-existing behavior is unrelated to whether a charge is pending.
    // Otherwise a PENDING charge (Airpay's real, always-returned status)
    // leaves the order PENDING until handleCheckOrderPaymentStatus confirms
    // it; a PAID charge (simulator) or no payment method at all is the
    // legacy instant-PAID path, unchanged.
    const status = oversold ? "NEEDS_REVIEW" : charge?.status === "PENDING" ? "PENDING" : "PAID";

    const created = await tx.order.create({
      data: {
        clientId,
        status,
        totalCents: finalTotalCents,
        currency: event.currency,
        waiverText: event.waiverText ?? null,
        waiverAcceptedAt: payload.waiverAccepted ? new Date() : null,
        discountCodeId: appliedDiscount?.id ?? null,
        discountCodeText: appliedDiscount?.code ?? null,
        discountTicketTypeName: appliedDiscount?.ticketTypeName ?? null,
        discountCents,
        paymentMethod: payload.paymentMethod ?? null,
        providerReference: charge?.reference ?? null,
        providerMessage: charge?.message ?? null,
        userId,
        eventId: event.id,
        items: { create: orderItemsData },
        tickets: { create: ticketsData },
        registrationAnswers: { create: answersData },
      },
      include: fullOrderInclude,
    });

    return { order: created, discountRejectReason };
    // Neon's pooled connection needs `pgbouncer=true` for interactive
    // transactions to commit correctly at all (see DEPLOYMENT.md) — that
    // makes Prisma hold one connection for the whole transaction, which
    // needs more than the 5s default when each statement is a real network
    // round-trip rather than a local one.
  }, { timeout: 15000, maxWait: 10000 });

  // Deferred until handleCheckOrderPaymentStatus confirms payment for a
  // still-PENDING order — sending it now would tell the buyer they have
  // valid tickets before Airpay has actually confirmed anything.
  const buyer = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
  if (buyer && order.status !== "PENDING") {
    const waiverLine = order.waiverAcceptedAt ? " You accepted the event waiver at checkout." : "";
    const discountLine = order.discountCents > 0
      ? ` A discount of ${formatCents(order.discountCents, event.currency)} (code ${order.discountCodeText}) was applied.`
      : "";
    await sendNotification({
      type: "ORDER_CONFIRMATION",
      channel: "EMAIL",
      recipient: buyer.email,
      subject: `Your tickets for ${event.title}`,
      body: `Hi ${buyer.name}, your order for ${event.title} is confirmed. Total: ${formatCents(order.totalCents, event.currency)}. Ticket code(s): ${order.tickets.map((t) => t.code).join(", ")}.${discountLine}${waiverLine}`,
    });
  }

  // discountRejectReason is transient buyer-facing feedback, not persisted
  // — attached onto the shaped order here rather than threaded as a new
  // shapeOrder parameter, since every other call site (pull/idempotent
  // replay/refund) has no such context and must not fabricate one.
  return { ok: true, order: { ...shapeOrder(order), discountRejectReason }, oversold, ticketTypeUpdates };
}

const ticketInclude = {
  event: { select: { id: true, organizationId: true } },
  order: { select: { id: true, status: true } },
} as const;

export function shapeTicket(t: any) {
  return {
    id: t.id,
    clientId: t.clientId,
    code: t.code,
    checkedIn: t.checkedIn,
    checkedInAt: t.checkedInAt ? t.checkedInAt.toISOString() : null,
    orderId: t.orderId,
    eventId: t.eventId,
    ticketTypeId: t.ticketTypeId,
  };
}

export async function handleCheckIn(userId: string, organizationId: string, payload: any) {
  const code = String(payload.ticketCode);
  const ticket = await prisma.ticket.findUnique({ where: { code }, include: ticketInclude });
  if (!ticket) {
    return { ok: false, retry: true, reason: "TICKET_NOT_FOUND" };
  }
  if (ticket.event.organizationId !== organizationId) {
    return { ok: false, reason: "FORBIDDEN" };
  }
  // Payment/refund problems aren't fixable by retrying the scan — unlike
  // TICKET_NOT_FOUND, none of these carry retry: true. NEEDS_REVIEW stays
  // allowed at the gate — pre-existing, unrelated oversell-review behavior.
  if (ticket.order.status === "PENDING") {
    return { ok: false, reason: "PAYMENT_PENDING" };
  }
  if (ticket.order.status === "PAYMENT_FAILED") {
    return { ok: false, reason: "PAYMENT_FAILED" };
  }
  if (ticket.order.status === "REFUNDED") {
    return { ok: false, reason: "ORDER_REFUNDED" };
  }
  if (ticket.checkedIn) {
    return { ok: true, ticket: shapeTicket(ticket), alreadyCheckedIn: true };
  }
  const updated = await prisma.ticket.update({
    where: { id: ticket.id },
    data: { checkedIn: true, checkedInAt: new Date(payload.scannedAt ?? Date.now()) },
    include: ticketInclude,
  });
  return {
    ok: true,
    ticket: shapeTicket(updated),
  };
}

export async function handleAddMobileMoneyAccount(userId: string, organizationId: string, payload: any) {
  const account = await prisma.mobileMoneyAccount.create({
    data: {
      provider: String(payload.provider),
      phoneNumber: String(payload.phoneNumber),
      accountName: String(payload.accountName),
      isDefault: true,
      organizationId,
    },
  });
  await prisma.mobileMoneyAccount.updateMany({
    where: { organizationId, id: { not: account.id } },
    data: { isDefault: false },
  });
  return {
    ok: true,
    account: {
      id: account.id,
      clientId: account.id,
      provider: account.provider,
      phoneNumber: account.phoneNumber,
      accountName: account.accountName,
      isDefault: account.isDefault,
      organizationId: account.organizationId,
    },
  };
}

export async function handleEditEvent(userId: string, organizationId: string, payload: any) {
  const event = await resolveEventId(String(payload.eventId), payload.eventClientId);
  if (!event) {
    return { ok: false, retry: true, reason: "EVENT_NOT_SYNCED_YET" };
  }
  if (event.organizationId !== organizationId) {
    return { ok: false, reason: "FORBIDDEN" };
  }

  const data: Record<string, unknown> = {};
  for (const key of ["title", "description", "category", "venue", "city", "imageUrl"] as const) {
    if (payload[key] !== undefined) data[key] = String(payload[key]);
  }
  if (payload.startsAt !== undefined) data.startsAt = new Date(payload.startsAt);
  if (payload.vendorApplicationsOpen !== undefined) data.vendorApplicationsOpen = Boolean(payload.vendorApplicationsOpen);
  if (payload.vendorStallFeeCents !== undefined) data.vendorStallFeeCents = Number(payload.vendorStallFeeCents);
  if (payload.waiverText !== undefined) {
    data.waiverText = payload.waiverText === null || payload.waiverText === "" ? null : String(payload.waiverText);
  }

  if (payload.currency !== undefined && payload.currency !== event.currency) {
    // Changing currency after any ticket has sold would make historical
    // order/settlement totals silently wrong (no conversion happens) — the
    // event has to be re-created instead.
    const hasSales = await prisma.ticketType.findFirst({
      where: { eventId: event.id, quantitySold: { gt: 0 } },
    });
    if (hasSales) {
      return { ok: false, reason: "CURRENCY_LOCKED" };
    }
    data.currency = String(payload.currency);
  }

  // Populated as ticketTypes are upserted below, so a discountCode in the
  // SAME payload can target a ticket type that only gets its real id right
  // here (e.g. an organizer creating "VIP" and a VIP-only code in one save).
  const ticketTypeIdByClientId = new Map<string, string>();

  if (Array.isArray(payload.ticketTypes)) {
    for (const tt of payload.ticketTypes as any[]) {
      if (tt.id) {
        const current = await prisma.ticketType.findUnique({ where: { id: tt.id } });
        if (!current || current.eventId !== event.id) continue;
        if (Number(tt.quantityTotal) < current.quantitySold) {
          return { ok: false, reason: "QUANTITY_BELOW_SOLD" };
        }
        await prisma.ticketType.update({
          where: { id: tt.id },
          data: {
            name: String(tt.name),
            description: String(tt.description ?? ""),
            priceCents: Number(tt.priceCents),
            quantityTotal: Number(tt.quantityTotal),
          },
        });
        if (tt.clientId) ticketTypeIdByClientId.set(String(tt.clientId), tt.id);
      } else {
        const existingByClientId = await prisma.ticketType.findUnique({ where: { clientId: String(tt.clientId) } });
        if (!existingByClientId) {
          const createdTt = await prisma.ticketType.create({
            data: {
              clientId: String(tt.clientId),
              eventId: event.id,
              name: String(tt.name),
              description: String(tt.description ?? ""),
              priceCents: Number(tt.priceCents),
              quantityTotal: Number(tt.quantityTotal),
            },
          });
          ticketTypeIdByClientId.set(String(tt.clientId), createdTt.id);
        } else {
          ticketTypeIdByClientId.set(String(tt.clientId), existingByClientId.id);
        }
      }
    }
  }

  // Same upsert-by-id-or-clientId shape as ticketTypes above — never
  // deleted server-side: removing a question from the organizer's form
  // just stops sending it, it isn't explicitly dropped (same convention).
  if (Array.isArray(payload.registrationQuestions)) {
    for (const q of payload.registrationQuestions as any[]) {
      if (q.id) {
        const current = await prisma.registrationQuestion.findUnique({ where: { id: q.id } });
        if (!current || current.eventId !== event.id) continue;
        await prisma.registrationQuestion.update({
          where: { id: q.id },
          data: {
            label: String(q.label),
            type: String(q.type),
            options: q.options !== undefined ? String(q.options) : null,
            required: Boolean(q.required ?? false),
            sortOrder: Number(q.sortOrder ?? 0),
          },
        });
      } else {
        const existingByClientId = await prisma.registrationQuestion.findUnique({ where: { clientId: String(q.clientId) } });
        if (!existingByClientId) {
          await prisma.registrationQuestion.create({
            data: {
              clientId: String(q.clientId),
              eventId: event.id,
              label: String(q.label),
              type: String(q.type),
              options: q.options !== undefined ? String(q.options) : null,
              required: Boolean(q.required ?? false),
              sortOrder: Number(q.sortOrder ?? 0),
            },
          });
        }
      }
    }
  }

  // Identical upsert-by-id-or-clientId shape as registrationQuestions above
  // — post-event survey questions, same never-delete convention. Rides
  // inside this same EDIT_EVENT save (one form, one save button) rather
  // than a separate op.
  if (Array.isArray(payload.surveyQuestions)) {
    for (const q of payload.surveyQuestions as any[]) {
      if (q.id) {
        const current = await prisma.surveyQuestion.findUnique({ where: { id: q.id } });
        if (!current || current.eventId !== event.id) continue;
        await prisma.surveyQuestion.update({
          where: { id: q.id },
          data: {
            label: String(q.label),
            type: String(q.type),
            options: q.options !== undefined ? String(q.options) : null,
            required: Boolean(q.required ?? false),
            sortOrder: Number(q.sortOrder ?? 0),
          },
        });
      } else {
        const existingByClientId = await prisma.surveyQuestion.findUnique({ where: { clientId: String(q.clientId) } });
        if (!existingByClientId) {
          await prisma.surveyQuestion.create({
            data: {
              clientId: String(q.clientId),
              eventId: event.id,
              label: String(q.label),
              type: String(q.type),
              options: q.options !== undefined ? String(q.options) : null,
              required: Boolean(q.required ?? false),
              sortOrder: Number(q.sortOrder ?? 0),
            },
          });
        }
      }
    }
  }

  // Same upsert-by-id-or-clientId shape as ticketTypes/registrationQuestions
  // above — never deleted server-side, "deactivate" flips active: false.
  // ticketTypeId may be a real id or a ticketTypes[].clientId from this same
  // payload — see ticketTypeIdByClientId above.
  if (Array.isArray(payload.discountCodes)) {
    for (const dc of payload.discountCodes as any[]) {
      const resolvedTicketTypeId = ticketTypeIdByClientId.get(String(dc.ticketTypeId)) ?? String(dc.ticketTypeId);
      const ticketType = await prisma.ticketType.findUnique({ where: { id: resolvedTicketTypeId } });
      if (!ticketType || ticketType.eventId !== event.id) continue; // can't resolve — skip, don't abort the whole save

      const isValidAmount =
        (dc.type === "PERCENT_OFF" && dc.percentOff != null && dc.amountOffCents == null) ||
        (dc.type === "FIXED_AMOUNT_OFF" && dc.amountOffCents != null && dc.percentOff == null);
      if (!isValidAmount) {
        return { ok: false, reason: "INVALID_DISCOUNT_CODE" };
      }

      const code = String(dc.code).trim().toUpperCase();
      const codeData = {
        code,
        type: String(dc.type),
        percentOff: dc.percentOff != null ? Number(dc.percentOff) : null,
        amountOffCents: dc.amountOffCents != null ? Number(dc.amountOffCents) : null,
        maxRedemptions: dc.maxRedemptions != null ? Number(dc.maxRedemptions) : null,
        expiresAt: dc.expiresAt ? new Date(dc.expiresAt) : null,
        active: dc.active ?? true,
        ticketTypeId: ticketType.id,
      };

      if (dc.id) {
        const current = await prisma.discountCode.findUnique({ where: { id: dc.id } });
        if (!current || current.eventId !== event.id) continue;
        const clash = await prisma.discountCode.findUnique({ where: { eventId_code: { eventId: event.id, code } } });
        if (clash && clash.id !== dc.id) {
          return { ok: false, reason: "DISCOUNT_CODE_TAKEN" };
        }
        await prisma.discountCode.update({ where: { id: dc.id }, data: codeData });
      } else {
        const existingByClientId = await prisma.discountCode.findUnique({ where: { clientId: String(dc.clientId) } });
        if (!existingByClientId) {
          const clash = await prisma.discountCode.findUnique({ where: { eventId_code: { eventId: event.id, code } } });
          if (clash) {
            return { ok: false, reason: "DISCOUNT_CODE_TAKEN" };
          }
          await prisma.discountCode.create({
            data: { clientId: String(dc.clientId), eventId: event.id, ...codeData },
          });
        }
      }
    }
  }

  const updated = await prisma.event.update({
    where: { id: event.id },
    data,
    include: {
      ticketTypes: true,
      organization: { select: { name: true } },
      vendors: { where: { status: "APPROVED" }, select: { id: true, name: true, category: true, boothNumber: true } },
      registrationQuestions: { orderBy: { sortOrder: "asc" } },
    },
  });

  return { ok: true, event: shapeEvent(updated, updated.organization.name) };
}

export async function handleCancelEvent(userId: string, organizationId: string, payload: any) {
  const event = await resolveEventId(String(payload.eventId), payload.eventClientId);
  if (!event) {
    return { ok: false, retry: true, reason: "EVENT_NOT_SYNCED_YET" };
  }
  if (event.organizationId !== organizationId) {
    return { ok: false, reason: "FORBIDDEN" };
  }

  const updated = await prisma.event.update({
    where: { id: event.id },
    data: { status: "CANCELLED" },
    include: {
      ticketTypes: true,
      organization: { select: { name: true } },
      vendors: { where: { status: "APPROVED" }, select: { id: true, name: true, category: true, boothNumber: true } },
      registrationQuestions: { orderBy: { sortOrder: "asc" } },
    },
  });

  const affectedOrders = await prisma.order.findMany({
    where: { eventId: event.id, status: { in: ["PAID", "NEEDS_REVIEW"] } },
    include: { user: { select: { email: true, name: true } } },
    distinct: ["userId"],
  });
  for (const o of affectedOrders) {
    await sendNotification({
      type: "EVENT_CANCELLED",
      channel: "EMAIL",
      recipient: o.user.email,
      subject: `${event.title} has been cancelled`,
      body: `Hi ${o.user.name}, the organizer has cancelled ${event.title}. Please contact them about a refund.`,
    });
  }

  return { ok: true, event: shapeEvent(updated, updated.organization.name) };
}

export async function handleRefundOrder(userId: string, organizationId: string, payload: any) {
  const orderId = String(payload.orderId);
  const orderClientId = payload.orderClientId as string | null | undefined;

  const fullInclude = {
    items: { include: { ticketType: true } },
    tickets: { include: { ticketType: true } },
    event: { select: { id: true, clientId: true, title: true, organizationId: true } },
    user: { select: { email: true, name: true } },
  } as const;

  const order =
    (await prisma.order.findUnique({ where: { id: orderId }, include: fullInclude })) ??
    (orderClientId
      ? await prisma.order.findUnique({ where: { clientId: orderClientId }, include: fullInclude })
      : null);

  if (!order) {
    return { ok: false, retry: true, reason: "ORDER_NOT_SYNCED_YET" };
  }
  if (order.event.organizationId !== organizationId) {
    return { ok: false, reason: "FORBIDDEN" };
  }
  if (order.status === "REFUNDED") {
    return { ok: true, order: shapeOrder(order), ticketTypeUpdates: [] };
  }
  // A PENDING/PAYMENT_FAILED order never actually collected payment (or is
  // still awaiting it) — refunding it is nonsensical, and for PAYMENT_FAILED
  // its inventory has already been released by handleCheckOrderPaymentStatus.
  if (order.status === "PENDING" || order.status === "PAYMENT_FAILED") {
    return { ok: false, reason: "ORDER_NOT_PAID" };
  }

  const alreadySettled = await prisma.settlementItem.findFirst({ where: { orderId: order.id } });
  if (alreadySettled) {
    return { ok: false, reason: "ALREADY_SETTLED" };
  }

  const ticketTypeUpdates: Array<{ id: string; quantitySold: number }> = [];

  const updated = await prisma.$transaction(async (tx) => {
    for (const item of order.items) {
      const tt = await tx.ticketType.update({
        where: { id: item.ticketTypeId },
        data: { quantitySold: { decrement: item.quantity } },
      });
      ticketTypeUpdates.push({ id: tt.id, quantitySold: Math.max(0, tt.quantitySold) });
    }
    return tx.order.update({
      where: { id: order.id },
      data: { status: "REFUNDED" },
      include: {
        items: { include: { ticketType: true } },
        tickets: { include: { ticketType: true } },
        event: { select: { id: true, clientId: true, title: true } },
      },
    });
  }, { timeout: 15000, maxWait: 10000 });

  await sendNotification({
    type: "REFUND_ISSUED",
    channel: "EMAIL",
    recipient: order.user.email,
    subject: `Your order for ${order.event.title} has been refunded`,
    body: `Hi ${order.user.name}, your order for ${order.event.title} (${formatCents(order.totalCents, order.currency)}) has been refunded and your ticket(s) are no longer valid for entry.`,
  });

  return { ok: true, order: shapeOrder(updated), ticketTypeUpdates };
}

// Mirrors handleCheckTopupStatus's CAS-on-status polling exactly, plus the
// CAS+release discipline handleRejectWithdrawal uses for its refund — here,
// a FAILED verification atomically flips the order status AND releases the
// inventory that was optimistically reserved at SELL_TICKETS time.
export async function handleCheckOrderPaymentStatus(payload: any) {
  const order =
    (await prisma.order.findUnique({ where: { id: String(payload.orderId) }, include: fullOrderInclude })) ??
    (payload.orderClientId
      ? await prisma.order.findUnique({ where: { clientId: String(payload.orderClientId) }, include: fullOrderInclude })
      : null);

  if (!order) {
    return { ok: false, retry: true, reason: "ORDER_NOT_SYNCED_YET" };
  }
  if (order.status !== "PENDING") {
    return { ok: true, order: shapeOrder(order), ticketTypeUpdates: [] };
  }
  if (!order.providerReference) {
    return { ok: true, order: shapeOrder(order), ticketTypeUpdates: [] };
  }

  const result = await verifyAirpayOrder(order.providerReference);
  if (result.status === "PENDING") {
    return { ok: true, order: shapeOrder(order), ticketTypeUpdates: [] };
  }

  if (result.status === "PAID") {
    // CAS on status only — no inventory change needed, it was already
    // reserved at order-creation time (unlike a wallet top-up, which only
    // credits the balance once COMPLETED).
    const res = await prisma.order.updateMany({
      where: { id: order.id, status: "PENDING" },
      data: { status: "PAID", providerMessage: result.message ?? null },
    });
    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: fullOrderInclude });
    if (res.count > 0) {
      // Only just transitioned to PAID by this call — fire the confirmation
      // that handleSellTickets deferred for a still-PENDING order.
      const buyer = await prisma.user.findUnique({ where: { id: fresh.userId }, select: { email: true, name: true } });
      if (buyer) {
        await sendNotification({
          type: "ORDER_CONFIRMATION",
          channel: "EMAIL",
          recipient: buyer.email,
          subject: `Your tickets for ${fresh.event.title}`,
          body: `Hi ${buyer.name}, your payment for ${fresh.event.title} was confirmed. Total: ${formatCents(fresh.totalCents, fresh.currency)}. Ticket code(s): ${fresh.tickets.map((t) => t.code).join(", ")}.`,
        });
      }
    }
    return { ok: true, order: shapeOrder(fresh), ticketTypeUpdates: [] };
  }

  // FAILED — CAS the status and release the reserved inventory atomically.
  // Ticket rows are never deleted (never-delete convention); they're simply
  // gated out of check-in by order.status going forward.
  const ticketTypeUpdates: Array<{ id: string; quantitySold: number }> = [];
  const outcome = await prisma.$transaction(async (tx) => {
    const res = await tx.order.updateMany({
      where: { id: order.id, status: "PENDING" },
      data: { status: "PAYMENT_FAILED", providerMessage: result.message ?? null },
    });
    if (res.count === 0) return null; // already resolved by a race/replay
    for (const item of order.items) {
      const tt = await tx.ticketType.update({
        where: { id: item.ticketTypeId },
        data: { quantitySold: { decrement: item.quantity } },
      });
      ticketTypeUpdates.push({ id: tt.id, quantitySold: Math.max(0, tt.quantitySold) });
    }
    return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: fullOrderInclude });
  }, { timeout: 15000, maxWait: 10000 });

  if (!outcome) {
    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: fullOrderInclude });
    return { ok: true, order: shapeOrder(fresh), ticketTypeUpdates: [] };
  }

  const buyer = await prisma.user.findUnique({ where: { id: outcome.userId }, select: { email: true, name: true } });
  if (buyer) {
    await sendNotification({
      type: "ORDER_PAYMENT_FAILED",
      channel: "EMAIL",
      recipient: buyer.email,
      subject: `Payment failed for ${outcome.event.title}`,
      body: `Hi ${buyer.name}, your mobile money payment for ${outcome.event.title} was not confirmed${result.message ? `: ${result.message}` : "."} Your reserved tickets have been released. No charge was made — please try again.`,
    });
  }
  return { ok: true, order: shapeOrder(outcome), ticketTypeUpdates };
}

export function shapeVendor(v: any) {
  return {
    id: v.id,
    clientId: v.clientId,
    eventId: v.eventId,
    eventClientId: v.event?.clientId ?? null,
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
  };
}

const vendorInclude = { event: { select: { id: true, clientId: true, organizationId: true } } } as const;

export async function handleApplyVendor(userId: string, payload: any) {
  const clientId = String(payload.clientId);

  const existing = await prisma.vendor.findUnique({ where: { clientId }, include: vendorInclude });
  if (existing) {
    return { ok: true, vendor: shapeVendor(existing) };
  }

  const event = await resolveEventId(String(payload.eventId), payload.eventClientId);
  if (!event) {
    return { ok: false, retry: true, reason: "EVENT_NOT_SYNCED_YET" };
  }
  if (!event.vendorApplicationsOpen) {
    return { ok: false, reason: "APPLICATIONS_CLOSED" };
  }

  const created = await prisma.vendor.create({
    data: {
      clientId,
      eventId: event.id,
      name: String(payload.name),
      category: String(payload.category),
      description: String(payload.description ?? ""),
      contactEmail: String(payload.contactEmail),
      contactPhone: String(payload.contactPhone),
      status: "PENDING",
      // Derived server-side from the event, never trusted from the client —
      // same discipline SELL_TICKETS uses for totalCents.
      stallFeeCents: event.vendorStallFeeCents,
      currency: event.currency,
      feeStatus: event.vendorStallFeeCents > 0 ? "PAID" : "NONE",
      ownerUserId: userId,
    },
    include: vendorInclude,
  });

  return { ok: true, vendor: shapeVendor(created) };
}

export async function handleAddVendor(userId: string, organizationId: string, payload: any) {
  const clientId = String(payload.clientId);

  const existing = await prisma.vendor.findUnique({ where: { clientId }, include: vendorInclude });
  if (existing) {
    return { ok: true, vendor: shapeVendor(existing) };
  }

  const event = await resolveEventId(String(payload.eventId), payload.eventClientId);
  if (!event) {
    return { ok: false, retry: true, reason: "EVENT_NOT_SYNCED_YET" };
  }
  if (event.organizationId !== organizationId) {
    return { ok: false, reason: "FORBIDDEN" };
  }

  const created = await prisma.vendor.create({
    data: {
      clientId,
      eventId: event.id,
      name: String(payload.name),
      category: String(payload.category),
      description: String(payload.description ?? ""),
      contactEmail: String(payload.contactEmail ?? ""),
      contactPhone: String(payload.contactPhone ?? ""),
      status: "APPROVED",
      boothNumber: payload.boothNumber ? String(payload.boothNumber) : null,
      badgeCode: String(payload.badgeCode),
      feeStatus: payload.feeStatus === "PAID" ? "PAID" : "NONE",
      currency: event.currency,
    },
    include: vendorInclude,
  });

  return { ok: true, vendor: shapeVendor(created) };
}

export function shapeSponsor(s: any) {
  return {
    id: s.id,
    clientId: s.clientId,
    eventId: s.eventId,
    eventClientId: s.event?.clientId ?? null,
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
  };
}

const sponsorInclude = { event: { select: { id: true, clientId: true, organizationId: true } } } as const;

export async function handleAddSponsor(userId: string, organizationId: string, payload: any) {
  const clientId = String(payload.clientId);

  const existing = await prisma.sponsor.findUnique({ where: { clientId }, include: sponsorInclude });
  if (existing) {
    return { ok: true, sponsor: shapeSponsor(existing) };
  }

  const event = await resolveEventId(String(payload.eventId), payload.eventClientId);
  if (!event) {
    return { ok: false, retry: true, reason: "EVENT_NOT_SYNCED_YET" };
  }
  if (event.organizationId !== organizationId) {
    return { ok: false, reason: "FORBIDDEN" };
  }

  const created = await prisma.sponsor.create({
    data: {
      clientId,
      eventId: event.id,
      name: String(payload.name),
      tier: String(payload.tier),
      description: String(payload.description ?? ""),
      contactEmail: String(payload.contactEmail ?? ""),
      contactPhone: String(payload.contactPhone ?? ""),
      feeCents: payload.feeCents != null ? Number(payload.feeCents) : 0,
      feeStatus: payload.feeStatus === "PAID" ? "PAID" : "NONE",
      currency: event.currency,
    },
    include: sponsorInclude,
  });

  return { ok: true, sponsor: shapeSponsor(created) };
}

export function shapeSponsorCampaign(c: any) {
  return {
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
  };
}

async function resolveSponsor(sponsorId: string, sponsorClientId?: string | null) {
  return (
    (await prisma.sponsor.findUnique({ where: { id: sponsorId }, include: sponsorInclude })) ??
    (sponsorClientId
      ? await prisma.sponsor.findUnique({ where: { clientId: sponsorClientId }, include: sponsorInclude })
      : null)
  );
}

export async function handleAddSponsorCampaign(userId: string, organizationId: string, payload: any) {
  const clientId = String(payload.clientId);

  const existing = await prisma.sponsorCampaign.findUnique({ where: { clientId } });
  if (existing) {
    return { ok: true, campaign: shapeSponsorCampaign(existing) };
  }

  const sponsor = await resolveSponsor(String(payload.sponsorId), payload.sponsorClientId);
  if (!sponsor) {
    return { ok: false, retry: true, reason: "SPONSOR_NOT_SYNCED_YET" };
  }
  if (sponsor.event.organizationId !== organizationId) {
    return { ok: false, reason: "FORBIDDEN" };
  }

  const code = String(payload.code).trim().toUpperCase();
  const clash = await prisma.sponsorCampaign.findUnique({ where: { sponsorId_code: { sponsorId: sponsor.id, code } } });
  if (clash) {
    return { ok: false, reason: "CAMPAIGN_CODE_TAKEN" };
  }

  const created = await prisma.sponsorCampaign.create({
    data: {
      clientId,
      sponsorId: sponsor.id,
      name: String(payload.name),
      code,
      maxRedemptions: payload.maxRedemptions != null ? Number(payload.maxRedemptions) : null,
      expiresAt: payload.expiresAt ? new Date(payload.expiresAt) : null,
    },
  });

  return { ok: true, campaign: shapeSponsorCampaign(created) };
}

// Never a real delete, matching DiscountCode's own dashboard (no
// reactivate affordance either) — a deactivated campaign just stops
// showing up as redeemable in the scan terminal's dropdown.
export async function handleDeactivateSponsorCampaign(userId: string, organizationId: string, payload: any) {
  const campaign =
    (await prisma.sponsorCampaign.findUnique({ where: { id: String(payload.campaignId) }, include: { sponsor: { include: sponsorInclude } } })) ??
    (payload.campaignClientId
      ? await prisma.sponsorCampaign.findUnique({ where: { clientId: String(payload.campaignClientId) }, include: { sponsor: { include: sponsorInclude } } })
      : null);
  if (!campaign) {
    return { ok: false, retry: true, reason: "CAMPAIGN_NOT_SYNCED_YET" };
  }
  if (campaign.sponsor.event.organizationId !== organizationId) {
    return { ok: false, reason: "FORBIDDEN" };
  }
  if (!campaign.active) {
    return { ok: true, campaign: shapeSponsorCampaign(campaign) }; // idempotent
  }

  const updated = await prisma.sponsorCampaign.update({ where: { id: campaign.id }, data: { active: false } });
  return { ok: true, campaign: shapeSponsorCampaign(updated) };
}

async function resolveVendor(vendorId: string, vendorClientId?: string | null) {
  return (
    (await prisma.vendor.findUnique({ where: { id: vendorId }, include: vendorInclude })) ??
    (vendorClientId
      ? await prisma.vendor.findUnique({ where: { clientId: vendorClientId }, include: vendorInclude })
      : null)
  );
}

export async function handleApproveVendor(userId: string, organizationId: string, payload: any) {
  const vendor = await resolveVendor(String(payload.vendorId), payload.vendorClientId);
  if (!vendor) {
    return { ok: false, retry: true, reason: "VENDOR_NOT_SYNCED_YET" };
  }
  if (vendor.event.organizationId !== organizationId) {
    return { ok: false, reason: "FORBIDDEN" };
  }
  if (vendor.status === "APPROVED") {
    return { ok: true, vendor: shapeVendor(vendor) };
  }

  const updated = await prisma.vendor.update({
    where: { id: vendor.id },
    data: {
      status: "APPROVED",
      boothNumber: payload.boothNumber ? String(payload.boothNumber) : vendor.boothNumber,
      badgeCode: String(payload.badgeCode),
    },
    include: vendorInclude,
  });

  return { ok: true, vendor: shapeVendor(updated) };
}

export async function handleRejectVendor(userId: string, organizationId: string, payload: any) {
  const vendor = await resolveVendor(String(payload.vendorId), payload.vendorClientId);
  if (!vendor) {
    return { ok: false, retry: true, reason: "VENDOR_NOT_SYNCED_YET" };
  }
  if (vendor.event.organizationId !== organizationId) {
    return { ok: false, reason: "FORBIDDEN" };
  }
  if (vendor.status === "REJECTED") {
    return { ok: true, vendor: shapeVendor(vendor) };
  }

  const updated = await prisma.vendor.update({
    where: { id: vendor.id },
    data: {
      status: "REJECTED",
      // Symbolic — no real money moves anywhere in this app yet (see
      // README's "Simulated pieces"), matching how ticket refunds work.
      feeStatus: vendor.feeStatus === "PAID" ? "REFUNDED" : vendor.feeStatus,
    },
    include: vendorInclude,
  });

  return { ok: true, vendor: shapeVendor(updated) };
}

export async function handleCheckInVendor(userId: string, organizationId: string, payload: any) {
  const badgeCode = String(payload.badgeCode);
  const vendor = await prisma.vendor.findUnique({ where: { badgeCode }, include: vendorInclude });
  if (!vendor) {
    return { ok: false, retry: true, reason: "VENDOR_NOT_FOUND" };
  }
  if (vendor.event.organizationId !== organizationId) {
    return { ok: false, reason: "FORBIDDEN" };
  }
  if (vendor.status !== "APPROVED") {
    return { ok: false, reason: "NOT_APPROVED" };
  }
  if (vendor.checkedIn) {
    return { ok: true, vendor: shapeVendor(vendor), alreadyCheckedIn: true };
  }
  const updated = await prisma.vendor.update({
    where: { id: vendor.id },
    data: { checkedIn: true, checkedInAt: new Date(payload.scannedAt ?? Date.now()) },
    include: vendorInclude,
  });
  return { ok: true, vendor: shapeVendor(updated) };
}

export function shapeWallet(w: any) {
  return {
    id: w.id,
    clientId: w.clientId,
    code: w.code,
    eventId: w.eventId,
    eventClientId: w.event?.clientId ?? null,
    ownerUserId: w.ownerUserId,
    // Organizer-visible only in practice (a buyer's own wallet trivially
    // includes their own name/email) — surfaced so the withdrawal review
    // queue can show organizers who to pay.
    ownerName: w.owner?.name ?? null,
    ownerEmail: w.owner?.email ?? null,
    balanceCents: w.balanceCents,
    currency: w.currency,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}

export function shapeWalletTransaction(t: any) {
  return {
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
    mobileNetwork: t.mobileNetwork ?? null,
    note: t.note ?? null,
    vendorId: t.vendorId,
    vendorName: t.vendor?.name ?? null,
    sponsorId: t.sponsorId,
    sponsorName: t.sponsor?.name ?? null,
    campaignId: t.campaignId,
    campaignName: t.campaign?.name ?? null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

const walletInclude = {
  event: { select: { id: true, clientId: true, status: true, currency: true, organizationId: true } },
  owner: { select: { name: true, email: true } },
} as const;
const walletTxInclude = {
  vendor: { select: { name: true } },
  sponsor: { select: { name: true } },
  campaign: { select: { name: true } },
} as const;

async function resolveWallet(walletId: string, walletClientId?: string | null) {
  return (
    (await prisma.wallet.findUnique({ where: { id: walletId }, include: walletInclude })) ??
    (walletClientId
      ? await prisma.wallet.findUnique({ where: { clientId: walletClientId }, include: walletInclude })
      : null)
  );
}

export async function handleCreateWallet(userId: string, payload: any) {
  const clientId = String(payload.clientId);

  const existing = await prisma.wallet.findUnique({ where: { clientId }, include: walletInclude });
  if (existing) {
    return { ok: true, wallet: shapeWallet(existing) };
  }

  const event = await resolveEventId(String(payload.eventId), payload.eventClientId);
  if (!event) {
    return { ok: false, retry: true, reason: "EVENT_NOT_SYNCED_YET" };
  }
  if (event.status !== "LIVE") {
    return { ok: false, reason: "EVENT_NOT_LIVE" };
  }

  // One wallet per user per event — if they already have one (e.g. this is
  // a replay with a different clientId, or a stale local record), return
  // the existing one instead of hitting the @@unique constraint.
  const existingForUser = await prisma.wallet.findUnique({
    where: { eventId_ownerUserId: { eventId: event.id, ownerUserId: userId } },
    include: walletInclude,
  });
  if (existingForUser) {
    return { ok: true, wallet: shapeWallet(existingForUser) };
  }

  const created = await prisma.wallet.create({
    data: {
      clientId,
      code: String(payload.code),
      eventId: event.id,
      ownerUserId: userId,
      currency: event.currency,
    },
    include: walletInclude,
  });

  return { ok: true, wallet: shapeWallet(created) };
}

const provisionUserSelect = { id: true, name: true, email: true } as const;

function shapeCredential(c: any) {
  return { id: c.id, nfcUid: c.nfcUid, status: c.status, ticketId: c.ticketId, walletId: c.walletId, code: c.code };
}

// Offline outbox counterpart to what was previously the provisionWristband
// Server Action (src/lib/wristband-handlers.ts, now removed) — same
// find-or-create-attendee/wallet, best-effort ticket link, and
// supersede-then-create Credential logic, with one addition an outbox op
// needs that a single UI-triggered Server Action call didn't: a clientId
// idempotency check, since a queued op can be retried after a dropped
// response. findUnique(email) ?? create(...) for the attendee, and the
// eventId_ownerUserId unique for the wallet, are already replay-safe on
// their own (same reasoning handleCreateWallet's own fallback lookup
// relies on) — the clientId check below is specifically for the Credential
// rows themselves, which have no other natural uniqueness to fall back on.
export async function handleProvisionCredential(userId: string, organizationId: string, payload: any) {
  const clientId = String(payload.clientId);

  const existingCredentials = await prisma.credential.findMany({ where: { clientId } });
  if (existingCredentials.length > 0) {
    const wallet = await prisma.wallet.findUnique({
      where: { id: existingCredentials.find((c) => c.walletId)?.walletId ?? "" },
      include: walletInclude,
    });
    const [user, event] = await Promise.all([
      wallet ? prisma.user.findUnique({ where: { id: wallet.ownerUserId }, select: provisionUserSelect }) : null,
      prisma.event.findUnique({ where: { id: String(payload.eventId) }, select: { title: true } }),
    ]);
    return {
      ok: true,
      credentials: existingCredentials.map(shapeCredential),
      wallet: wallet ? shapeWallet(wallet) : null,
      user,
      eventTitle: event?.title,
    };
  }

  const event = await resolveEventId(String(payload.eventId), payload.eventClientId);
  if (!event) {
    return { ok: false, retry: true, reason: "EVENT_NOT_SYNCED_YET" };
  }
  if (event.organizationId !== organizationId) {
    return { ok: false, reason: "FORBIDDEN" };
  }

  const nfcUid = String(payload.nfcUid);
  // Resolved server-side from the authenticated actor, not trusted from the
  // payload — payloadSchemas.PROVISION_CREDENTIAL has no actorName field
  // (unlike the old Server Action, which got it for free from the session
  // in its own wrapper), so this handler looks it up itself instead.
  const actor = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
  const actorName = actor?.name ?? actor?.email ?? "Unknown";

  const outcome = await prisma.$transaction(
    async (tx) => {
      let user;
      if (payload.userId) {
        user = await tx.user.findUniqueOrThrow({ where: { id: String(payload.userId) }, select: provisionUserSelect });
      } else {
        const email = String(payload.email);
        user = await tx.user.findUnique({ where: { email }, select: provisionUserSelect });
        if (!user) {
          // No account yet (a walk-up attendee) — create a real, functional
          // User row with a random password nobody knows. They can later
          // claim it via the existing generic "forgot password" flow (which
          // already works for any email with a User row, regardless of how
          // its hash was set) — same shape as a normal door-sale account.
          const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
          user = await tx.user.create({
            data: { name: String(payload.name), email, passwordHash },
            select: provisionUserSelect,
          });
        }
      }

      let wallet = await tx.wallet.findUnique({
        where: { eventId_ownerUserId: { eventId: event.id, ownerUserId: user.id } },
        include: walletInclude,
      });
      if (!wallet) {
        wallet = await tx.wallet.create({
          data: {
            clientId: payload.walletClientId ? String(payload.walletClientId) : undefined,
            code: generateTicketCode(),
            eventId: event.id,
            ownerUserId: user.id,
            currency: event.currency,
          },
          include: walletInclude,
        });
      }

      // Best-effort, read-only — a Ticket only exists via a completed
      // order, never created here. Covers both the original buyer and
      // someone who received this ticket via an accepted transfer.
      const ticket = await tx.ticket.findFirst({
        where: {
          eventId: event.id,
          order: { status: { in: ["PAID", "NEEDS_REVIEW"] } },
          OR: [{ order: { userId: user.id } }, { currentHolderUserId: user.id }],
        },
      });

      // A physical tag can only meaningfully belong to one person at a time
      // — supersede anything ACTIVE that collides on this uid, OR on the
      // wallet/ticket we're about to (re-)link, before creating new rows.
      await tx.credential.updateMany({
        where: {
          organizationId,
          status: "ACTIVE",
          OR: [{ nfcUid }, { walletId: wallet.id }, ...(ticket ? [{ ticketId: ticket.id }] : [])],
        },
        data: { status: "SUPERSEDED", supersededAt: new Date(), supersededByUserId: userId },
      });

      const walletCredential = await tx.credential.create({
        data: {
          clientId,
          organizationId,
          nfcUid,
          walletId: wallet.id,
          code: wallet.code,
          createdByUserId: userId,
          createdByName: actorName,
        },
      });
      const credentials = [walletCredential];
      if (ticket) {
        const ticketCredential = await tx.credential.create({
          data: {
            clientId,
            organizationId,
            nfcUid,
            ticketId: ticket.id,
            code: ticket.code,
            createdByUserId: userId,
            createdByName: actorName,
          },
        });
        credentials.push(ticketCredential);
      }

      return { user, wallet, credentials, eventTitle: event.title };
    },
    { timeout: 15000, maxWait: 10000 }
  );

  return {
    ok: true,
    credentials: outcome.credentials.map(shapeCredential),
    wallet: shapeWallet(outcome.wallet),
    user: outcome.user,
    eventTitle: outcome.eventTitle,
  };
}

export async function handleTopupWallet(userId: string, payload: any) {
  const clientId = String(payload.clientId);

  const existingTx = await prisma.walletTransaction.findUnique({ where: { clientId }, include: walletTxInclude });
  if (existingTx) {
    return { ok: true, transaction: shapeWalletTransaction(existingTx), wallet: null };
  }

  const wallet = await resolveWallet(String(payload.walletId), payload.walletClientId);
  if (!wallet) {
    return { ok: false, retry: true, reason: "WALLET_NOT_SYNCED_YET" };
  }
  if (wallet.event.status !== "LIVE") {
    return { ok: false, reason: "EVENT_NOT_LIVE" };
  }
  if (wallet.ownerUserId !== userId) {
    return { ok: false, reason: "FORBIDDEN" };
  }

  const amountCents = Number(payload.amountCents);
  const provider = getActivePaymentProvider();
  const charge = await provider.initiateCharge({
    orderClientId: clientId,
    amountCents,
    phoneNumber: payload.phoneNumber ? String(payload.phoneNumber) : undefined,
    mobileNetwork: payload.mobileNetwork ? String(payload.mobileNetwork) : undefined,
    description: `Wallet top-up — ${wallet.code}`,
  });

  const baseData = {
    clientId,
    type: "TOPUP",
    amountCents,
    currency: wallet.currency,
    providerReference: charge.reference || null,
    providerMessage: charge.message ?? null,
    phoneNumber: payload.phoneNumber ? String(payload.phoneNumber) : null,
    walletId: wallet.id,
  };

  if (charge.status === "PAID") {
    // Credit the balance and log the transaction in one transaction — see
    // handleChargeWallet for why this codebase treats wallet balance
    // mutations as needing the same $transaction discipline as ticket
    // inventory (oversell guard) rather than two separate writes.
    const result = await prisma.$transaction(async (tx) => {
      const updatedWallet = await tx.wallet.update({
        where: { id: wallet.id },
        data: { balanceCents: { increment: amountCents } },
        include: walletInclude,
      });
      const transaction = await tx.walletTransaction.create({
        data: { ...baseData, status: "COMPLETED" },
        include: walletTxInclude,
      });
      return { updatedWallet, transaction };
    }, { timeout: 15000, maxWait: 10000 });

    return { ok: true, transaction: shapeWalletTransaction(result.transaction), wallet: shapeWallet(result.updatedWallet) };
  }

  // PENDING (awaiting buyer confirmation) or FAILED (declined) — either way
  // the balance is untouched. Both are legitimate terminal-for-now states,
  // not sync failures, so this still returns ok: true.
  const transaction = await prisma.walletTransaction.create({
    data: { ...baseData, status: charge.status === "PENDING" ? "PENDING" : "FAILED" },
    include: walletTxInclude,
  });
  return { ok: true, transaction: shapeWalletTransaction(transaction), wallet: shapeWallet(wallet) };
}

export async function handleCheckTopupStatus(payload: any) {
  const tx =
    (await prisma.walletTransaction.findUnique({
      where: { id: String(payload.walletTransactionId) },
      include: walletTxInclude,
    })) ??
    (payload.walletTransactionClientId
      ? await prisma.walletTransaction.findUnique({
          where: { clientId: String(payload.walletTransactionClientId) },
          include: walletTxInclude,
        })
      : null);

  if (!tx) {
    return { ok: false, retry: true, reason: "TRANSACTION_NOT_SYNCED_YET" };
  }
  if (tx.status !== "PENDING") {
    return { ok: true, transaction: shapeWalletTransaction(tx), wallet: null };
  }
  if (!tx.providerReference) {
    return { ok: true, transaction: shapeWalletTransaction(tx), wallet: null };
  }

  const result = await verifyAirpayOrder(tx.providerReference);
  if (result.status === "PENDING") {
    return { ok: true, transaction: shapeWalletTransaction(tx), wallet: null };
  }

  if (result.status === "PAID") {
    // Compare-and-swap on status so a racing auto-check (page mount) and a
    // manual "check status" click can't both credit the balance.
    const updated = await prisma.$transaction(async (dbTx) => {
      const res = await dbTx.walletTransaction.updateMany({
        where: { id: tx.id, status: "PENDING" },
        data: { status: "COMPLETED", providerMessage: result.message ?? null },
      });
      if (res.count === 0) return null;
      const updatedWallet = await dbTx.wallet.update({
        where: { id: tx.walletId },
        data: { balanceCents: { increment: tx.amountCents ?? 0 } },
        include: walletInclude,
      });
      const updatedTx = await dbTx.walletTransaction.findUniqueOrThrow({
        where: { id: tx.id },
        include: walletTxInclude,
      });
      return { updatedWallet, updatedTx };
    }, { timeout: 15000, maxWait: 10000 });

    if (!updated) {
      // Already resolved by a concurrent check — fetch fresh and return it.
      const fresh = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: tx.id }, include: walletTxInclude });
      return { ok: true, transaction: shapeWalletTransaction(fresh), wallet: null };
    }
    return { ok: true, transaction: shapeWalletTransaction(updated.updatedTx), wallet: shapeWallet(updated.updatedWallet) };
  }

  // FAILED
  const updated = await prisma.walletTransaction.updateMany({
    where: { id: tx.id, status: "PENDING" },
    data: { status: "FAILED", providerMessage: result.message ?? null },
  });
  const fresh = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: tx.id }, include: walletTxInclude });
  return { ok: true, transaction: shapeWalletTransaction(fresh), wallet: null, updated: updated.count > 0 };
}

export async function handleChargeWallet(userId: string, organizationId: string, payload: any) {
  const clientId = String(payload.clientId);

  const existingTx = await prisma.walletTransaction.findUnique({ where: { clientId }, include: walletTxInclude });
  if (existingTx) {
    const wallet = await prisma.wallet.findUnique({ where: { id: existingTx.walletId }, include: walletInclude });
    if (!wallet || wallet.event.organizationId !== organizationId) {
      return { ok: false, reason: "FORBIDDEN" };
    }
    return { ok: true, transaction: shapeWalletTransaction(existingTx), wallet: shapeWallet(wallet) };
  }

  const walletCode = String(payload.walletCode);
  const wallet = await prisma.wallet.findUnique({ where: { code: walletCode }, include: walletInclude });
  if (!wallet) {
    return { ok: false, retry: true, reason: "WALLET_NOT_FOUND" };
  }
  if (wallet.event.organizationId !== organizationId) {
    return { ok: false, reason: "FORBIDDEN" };
  }
  if (wallet.event.status !== "LIVE") {
    return { ok: false, reason: "EVENT_NOT_LIVE" };
  }

  const vendor =
    (await prisma.vendor.findUnique({ where: { id: String(payload.vendorId) } })) ??
    (payload.vendorClientId
      ? await prisma.vendor.findUnique({ where: { clientId: String(payload.vendorClientId) } })
      : null);
  if (!vendor) {
    return { ok: false, retry: true, reason: "VENDOR_NOT_SYNCED_YET" };
  }
  if (vendor.status !== "APPROVED") {
    return { ok: false, reason: "VENDOR_NOT_APPROVED" };
  }
  if (vendor.eventId !== wallet.eventId) {
    return { ok: false, reason: "VENDOR_EVENT_MISMATCH" };
  }

  const amountCents = Number(payload.amountCents);

  // Compare-and-swap + audit log, atomically paired — same $transaction
  // discipline handleSellTickets/handleRefundOrder use for inventory, and
  // the same Neon-pooled-connection timeout every $transaction here needs.
  // The WHERE clause on the updateMany itself enforces the balance floor,
  // so at most one concurrent charge against the same wallet can succeed —
  // no separate read-then-write race window.
  const result = await prisma.$transaction(async (tx) => {
    const res = await tx.wallet.updateMany({
      where: { id: wallet.id, balanceCents: { gte: amountCents } },
      data: { balanceCents: { decrement: amountCents } },
    });

    if (res.count === 0) {
      // Declined, not a sync failure — log it (audit trail, same reasoning
      // as a FAILED top-up) and report ok:true with declined:true, matching
      // how handleSellTickets reports an oversold order as a successful
      // sync with a flag rather than a dropped/retried outbox entry.
      const declinedTx = await tx.walletTransaction.create({
        data: {
          clientId,
          type: "SALE",
          status: "FAILED",
          amountCents,
          currency: wallet.currency,
          walletId: wallet.id,
          vendorId: vendor.id,
          providerMessage: "Insufficient balance",
        },
        include: walletTxInclude,
      });
      return { declined: true as const, transaction: declinedTx, wallet: null };
    }

    const updatedWallet = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id }, include: walletInclude });
    const transaction = await tx.walletTransaction.create({
      data: {
        clientId,
        type: "SALE",
        status: "COMPLETED",
        amountCents,
        currency: wallet.currency,
        walletId: wallet.id,
        vendorId: vendor.id,
      },
      include: walletTxInclude,
    });
    return { declined: false as const, transaction, wallet: updatedWallet };
  }, { timeout: 15000, maxWait: 10000 });

  if (result.declined) {
    return {
      ok: true,
      transaction: shapeWalletTransaction(result.transaction),
      wallet: shapeWallet(wallet),
      declined: true,
      reason: "INSUFFICIENT_BALANCE",
    };
  }

  return { ok: true, transaction: shapeWalletTransaction(result.transaction), wallet: shapeWallet(result.wallet) };
}

// Buyer-initiated cash-out of a leftover wallet balance. No real
// disbursement API exists anywhere in this codebase (not even organizer
// settlements call one — see runSettlement's SIM- reference), so this is
// deliberately a request → organizer-review → paid workflow, not an
// automated payout: the balance is reserved (CAS-decremented) immediately
// so it can't be double-spent or double-withdrawn, and the resulting
// PENDING transaction sits until an organizer approves (asserting they've
// paid the buyer out manually) or rejects (refunding the balance) it — see
// handleApproveWithdrawal/handleRejectWithdrawal below. Deliberately no
// EVENT_NOT_LIVE gate, unlike handleTopupWallet — cashing out is exactly
// what a buyer needs to do once an event has ended, or even if cancelled.
export async function handleWithdrawWallet(userId: string, payload: any) {
  const clientId = String(payload.clientId);

  const existingTx = await prisma.walletTransaction.findUnique({ where: { clientId }, include: walletTxInclude });
  if (existingTx) {
    return { ok: true, transaction: shapeWalletTransaction(existingTx), wallet: null };
  }

  const wallet = await resolveWallet(String(payload.walletId), payload.walletClientId);
  if (!wallet) {
    return { ok: false, retry: true, reason: "WALLET_NOT_SYNCED_YET" };
  }
  if (wallet.ownerUserId !== userId) {
    return { ok: false, reason: "FORBIDDEN" };
  }

  const amountCents = Number(payload.amountCents);
  const phoneNumber = String(payload.phoneNumber);
  const mobileNetwork = String(payload.mobileNetwork);

  // Same CAS discipline as handleChargeWallet — the WHERE clause on the
  // updateMany is the balance floor guard, so at most one concurrent
  // withdraw/charge against the same wallet can succeed.
  const result = await prisma.$transaction(async (tx) => {
    const res = await tx.wallet.updateMany({
      where: { id: wallet.id, balanceCents: { gte: amountCents } },
      data: { balanceCents: { decrement: amountCents } },
    });

    if (res.count === 0) {
      const declinedTx = await tx.walletTransaction.create({
        data: {
          clientId, type: "WITHDRAWAL", status: "FAILED",
          amountCents, currency: wallet.currency, walletId: wallet.id,
          phoneNumber, mobileNetwork,
          providerMessage: "Insufficient balance",
        },
        include: walletTxInclude,
      });
      return { declined: true as const, transaction: declinedTx, wallet: null };
    }

    const updatedWallet = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id }, include: walletInclude });
    const transaction = await tx.walletTransaction.create({
      data: {
        clientId, type: "WITHDRAWAL", status: "PENDING",
        amountCents, currency: wallet.currency, walletId: wallet.id,
        phoneNumber, mobileNetwork,
      },
      include: walletTxInclude,
    });
    return { declined: false as const, transaction, wallet: updatedWallet };
  }, { timeout: 15000, maxWait: 10000 });

  if (result.declined) {
    return {
      ok: true,
      transaction: shapeWalletTransaction(result.transaction),
      wallet: shapeWallet(wallet),
      declined: true,
      reason: "INSUFFICIENT_BALANCE",
    };
  }

  // Notify the org's OWNER a request is waiting — after commit, mirroring
  // createSupportTicket's pattern in support-handlers.ts.
  const owner = await prisma.organizationMembership.findFirst({
    where: { organizationId: wallet.event.organizationId, role: "OWNER" },
    include: { user: { select: { email: true, name: true } } },
  });
  if (owner) {
    await sendNotification({
      type: "WITHDRAWAL_REQUESTED",
      channel: "EMAIL",
      recipient: owner.user.email,
      subject: `New wallet withdrawal request — ${formatCents(amountCents, wallet.currency)}`,
      body: `Hi ${owner.user.name}, a buyer requested to withdraw ${formatCents(amountCents, wallet.currency)} from their wallet (${wallet.code}). Review and pay them out from your dashboard.`,
    });
  }

  return { ok: true, transaction: shapeWalletTransaction(result.transaction), wallet: shapeWallet(result.wallet) };
}

async function resolveWithdrawalTransaction(walletTransactionId: string, walletTransactionClientId?: string | null) {
  return (
    (await prisma.walletTransaction.findUnique({
      where: { id: walletTransactionId },
      include: { ...walletTxInclude, wallet: { include: walletInclude } },
    })) ??
    (walletTransactionClientId
      ? await prisma.walletTransaction.findUnique({
          where: { clientId: walletTransactionClientId },
          include: { ...walletTxInclude, wallet: { include: walletInclude } },
        })
      : null)
  );
}

// Organizer marks a pending withdrawal as paid — this is their assertion
// that they've sent the buyer the money themselves (mobile money/cash),
// outside the platform, since no automated disbursement API exists (see
// handleWithdrawWallet's header comment). No balance change here — it was
// already reserved when the withdrawal was requested.
export async function handleApproveWithdrawal(userId: string, organizationId: string, payload: any) {
  const tx = await resolveWithdrawalTransaction(String(payload.walletTransactionId), payload.walletTransactionClientId);
  if (!tx) {
    return { ok: false, retry: true, reason: "TRANSACTION_NOT_SYNCED_YET" };
  }
  if (tx.type !== "WITHDRAWAL") {
    return { ok: false, reason: "NOT_A_WITHDRAWAL" };
  }
  if ((tx as any).wallet.event.organizationId !== organizationId) {
    return { ok: false, reason: "FORBIDDEN" };
  }

  // CAS on status so a replayed/racing approve can't double-fire the
  // notification below — same discipline as handleCheckTopupStatus.
  const res = await prisma.walletTransaction.updateMany({
    where: { id: tx.id, status: "PENDING" },
    data: { status: "COMPLETED" },
  });
  const fresh = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: tx.id }, include: walletTxInclude });

  if (res.count === 0) {
    // Already resolved (replay/race) — idempotent no-op.
    return { ok: true, transaction: shapeWalletTransaction(fresh) };
  }

  const walletOwner = await prisma.wallet.findUniqueOrThrow({
    where: { id: fresh.walletId },
    include: { owner: { select: { email: true, name: true } }, event: { select: { title: true } } },
  });
  await sendNotification({
    type: "WITHDRAWAL_DECIDED",
    channel: "EMAIL",
    recipient: walletOwner.owner.email,
    subject: "Your withdrawal request has been paid",
    body: `Hi ${walletOwner.owner.name}, your withdrawal of ${formatCents(fresh.amountCents ?? 0, fresh.currency)} for ${walletOwner.event.title} has been approved and paid out via ${fresh.mobileNetwork ?? "mobile money"} to ${fresh.phoneNumber}.`,
  });

  return { ok: true, transaction: shapeWalletTransaction(fresh) };
}

// Organizer declines a pending withdrawal — CAS-refunds the reserved
// balance back atomically with the status transition, so a replayed
// reject can never double-refund (the updateMany's WHERE status:"PENDING"
// is the single source of truth for "did this attempt actually win").
export async function handleRejectWithdrawal(userId: string, organizationId: string, payload: any) {
  const tx = await resolveWithdrawalTransaction(String(payload.walletTransactionId), payload.walletTransactionClientId);
  if (!tx) {
    return { ok: false, retry: true, reason: "TRANSACTION_NOT_SYNCED_YET" };
  }
  if (tx.type !== "WITHDRAWAL") {
    return { ok: false, reason: "NOT_A_WITHDRAWAL" };
  }
  if ((tx as any).wallet.event.organizationId !== organizationId) {
    return { ok: false, reason: "FORBIDDEN" };
  }

  const reason = payload.reason ? String(payload.reason) : null;

  const result = await prisma.$transaction(async (dbTx) => {
    const res = await dbTx.walletTransaction.updateMany({
      where: { id: tx.id, status: "PENDING" },
      data: { status: "FAILED", providerMessage: reason },
    });
    if (res.count === 0) return null; // already resolved — backstops double-refund
    const updatedWallet = await dbTx.wallet.update({
      where: { id: tx.walletId },
      data: { balanceCents: { increment: tx.amountCents ?? 0 } },
      include: walletInclude,
    });
    const updatedTx = await dbTx.walletTransaction.findUniqueOrThrow({ where: { id: tx.id }, include: walletTxInclude });
    return { updatedWallet, updatedTx };
  }, { timeout: 15000, maxWait: 10000 });

  if (!result) {
    const fresh = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: tx.id }, include: walletTxInclude });
    return { ok: true, transaction: shapeWalletTransaction(fresh), wallet: null };
  }

  const walletOwner = await prisma.wallet.findUniqueOrThrow({
    where: { id: tx.walletId },
    include: { owner: { select: { email: true, name: true } }, event: { select: { title: true } } },
  });
  await sendNotification({
    type: "WITHDRAWAL_DECIDED",
    channel: "EMAIL",
    recipient: walletOwner.owner.email,
    subject: "Your withdrawal request was declined",
    body: `Hi ${walletOwner.owner.name}, your withdrawal request for ${walletOwner.event.title} was declined${reason ? `: ${reason}.` : "."} The balance has been returned to your wallet.`,
  });

  return { ok: true, transaction: shapeWalletTransaction(result.updatedTx), wallet: shapeWallet(result.updatedWallet) };
}

export async function handleSponsorTap(userId: string, organizationId: string, payload: any) {
  const clientId = String(payload.clientId);

  const existingTx = await prisma.walletTransaction.findUnique({ where: { clientId }, include: walletTxInclude });
  if (existingTx) {
    const wallet = await prisma.wallet.findUnique({ where: { id: existingTx.walletId }, include: walletInclude });
    if (!wallet || wallet.event.organizationId !== organizationId) {
      return { ok: false, reason: "FORBIDDEN" };
    }
    return { ok: true, transaction: shapeWalletTransaction(existingTx) };
  }

  const walletCode = String(payload.walletCode);
  const wallet = await prisma.wallet.findUnique({ where: { code: walletCode }, include: walletInclude });
  if (!wallet) {
    return { ok: false, retry: true, reason: "WALLET_NOT_FOUND" };
  }
  if (wallet.event.organizationId !== organizationId) {
    return { ok: false, reason: "FORBIDDEN" };
  }

  const sponsor =
    (await prisma.sponsor.findUnique({ where: { id: String(payload.sponsorId) } })) ??
    (payload.sponsorClientId
      ? await prisma.sponsor.findUnique({ where: { clientId: String(payload.sponsorClientId) } })
      : null);
  if (!sponsor) {
    return { ok: false, retry: true, reason: "SPONSOR_NOT_SYNCED_YET" };
  }
  if (sponsor.eventId !== wallet.eventId) {
    return { ok: false, reason: "SPONSOR_EVENT_MISMATCH" };
  }

  // Wrapped in a transaction (unlike before campaigns existed) so the
  // redemption-cap increment and the tap row commit atomically — same
  // discipline as handleChargeWallet's balance CAS.
  const result = await prisma.$transaction(async (tx) => {
    let campaignId: string | null = null;
    let campaignRejectReason: string | null = null;

    const rawCampaignId = payload.campaignId ? String(payload.campaignId) : null;
    if (rawCampaignId || payload.campaignClientId) {
      const campaign =
        (rawCampaignId ? await tx.sponsorCampaign.findUnique({ where: { id: rawCampaignId } }) : null) ??
        (payload.campaignClientId
          ? await tx.sponsorCampaign.findUnique({ where: { clientId: String(payload.campaignClientId) } })
          : null);

      // Never blocks the tap itself — an invalid/inapplicable campaign
      // just means no redemption, same soft-fail philosophy as
      // DiscountCode in handleSellTickets.
      if (!campaign) campaignRejectReason = "CAMPAIGN_NOT_FOUND";
      else if (campaign.sponsorId !== sponsor.id) campaignRejectReason = "CAMPAIGN_SPONSOR_MISMATCH";
      else if (!campaign.active) campaignRejectReason = "CAMPAIGN_INACTIVE";
      else if (campaign.expiresAt && campaign.expiresAt < new Date()) campaignRejectReason = "CAMPAIGN_EXPIRED";
      else {
        const already = await tx.walletTransaction.findFirst({
          where: { campaignId: campaign.id, walletId: wallet.id },
        });
        if (already) {
          campaignRejectReason = "CAMPAIGN_ALREADY_REDEEMED";
        } else {
          // CAS on redemptionCount — same discipline as DiscountCode's
          // redemption in handleSellTickets, so two staff racing the last
          // redemption slot for two different attendees can't both win.
          const res = await tx.sponsorCampaign.updateMany({
            where: {
              id: campaign.id,
              active: true,
              OR: [{ maxRedemptions: null }, { redemptionCount: { lt: campaign.maxRedemptions ?? 0 } }],
            },
            data: { redemptionCount: { increment: 1 } },
          });
          if (res.count === 1) {
            campaignId = campaign.id;
          } else {
            campaignRejectReason = "CAMPAIGN_MAX_REDEEMED"; // lost the race
          }
        }
      }
    }

    const transaction = await tx.walletTransaction.create({
      data: {
        clientId,
        type: "SPONSOR_TAP",
        status: "COMPLETED",
        currency: wallet.currency,
        walletId: wallet.id,
        sponsorId: sponsor.id,
        campaignId,
        // Blank/whitespace-only collapses to null, so every downstream read
        // only ever checks truthy/falsy, never "" vs null.
        note: payload.note ? String(payload.note).trim() || null : null,
      },
      include: walletTxInclude,
    });

    return { transaction, campaignRedeemed: campaignId !== null, campaignRejectReason };
  }, { timeout: 15000, maxWait: 10000 });

  return {
    ok: true,
    transaction: shapeWalletTransaction(result.transaction),
    campaignRedeemed: result.campaignRedeemed,
    campaignRejectReason: result.campaignRejectReason,
  };
}
