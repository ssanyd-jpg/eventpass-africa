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

const registrationQuestionInputSchema = z.object({
  id: z.string().optional(),
  clientId: z.string().min(1),
  label: z.string().min(1).max(200),
  type: z.enum(REGISTRATION_QUESTION_TYPES),
  options: z.string().max(1000).optional(),
  required: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
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
    })),
    waiverText: o.waiverText ?? null,
    waiverAcceptedAt: o.waiverAcceptedAt ? o.waiverAcceptedAt.toISOString() : null,
    answers: (o.registrationAnswers ?? []).map((a: any) => ({
      questionId: a.questionId,
      questionLabel: a.question.label,
      value: a.value,
    })),
  };
}

export async function handleSellTickets(userId: string, payload: any) {
  const clientId = String(payload.clientId);

  const existing = await prisma.order.findUnique({
    where: { clientId },
    include: {
      items: { include: { ticketType: true } },
      tickets: { include: { ticketType: true } },
      event: { select: { id: true, clientId: true, title: true } },
      registrationAnswers: { include: { question: true } },
    },
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
  let oversold = false;
  let totalCents = 0;
  const ticketTypeUpdates: Array<{ id: string; quantitySold: number }> = [];

  const order = await prisma.$transaction(async (tx) => {
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

    const created = await tx.order.create({
      data: {
        clientId,
        status: oversold ? "NEEDS_REVIEW" : "PAID",
        totalCents,
        currency: event.currency,
        waiverText: event.waiverText ?? null,
        waiverAcceptedAt: payload.waiverAccepted ? new Date() : null,
        userId,
        eventId: event.id,
        items: { create: orderItemsData },
        tickets: { create: ticketsData },
        registrationAnswers: { create: answersData },
      },
      include: {
        items: { include: { ticketType: true } },
        tickets: { include: { ticketType: true } },
        event: { select: { id: true, clientId: true, title: true } },
        registrationAnswers: { include: { question: true } },
      },
    });

    return created;
    // Neon's pooled connection needs `pgbouncer=true` for interactive
    // transactions to commit correctly at all (see DEPLOYMENT.md) — that
    // makes Prisma hold one connection for the whole transaction, which
    // needs more than the 5s default when each statement is a real network
    // round-trip rather than a local one.
  }, { timeout: 15000, maxWait: 10000 });

  const buyer = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
  if (buyer) {
    const waiverLine = order.waiverAcceptedAt ? " You accepted the event waiver at checkout." : "";
    await sendNotification({
      type: "ORDER_CONFIRMATION",
      channel: "EMAIL",
      recipient: buyer.email,
      subject: `Your tickets for ${event.title}`,
      body: `Hi ${buyer.name}, your order for ${event.title} is confirmed. Total: ${formatCents(totalCents, event.currency)}. Ticket code(s): ${order.tickets.map((t) => t.code).join(", ")}.${waiverLine}`,
    });
  }

  return { ok: true, order: shapeOrder(order), oversold, ticketTypeUpdates };
}

const ticketInclude = { event: { select: { id: true, organizationId: true } } } as const;

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
      } else {
        const existingByClientId = await prisma.ticketType.findUnique({ where: { clientId: String(tt.clientId) } });
        if (!existingByClientId) {
          await prisma.ticketType.create({
            data: {
              clientId: String(tt.clientId),
              eventId: event.id,
              name: String(tt.name),
              description: String(tt.description ?? ""),
              priceCents: Number(tt.priceCents),
              quantityTotal: Number(tt.quantityTotal),
            },
          });
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
    vendorId: t.vendorId,
    vendorName: t.vendor?.name ?? null,
    sponsorId: t.sponsorId,
    sponsorName: t.sponsor?.name ?? null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

const walletInclude = { event: { select: { id: true, clientId: true, status: true, currency: true, organizationId: true } } } as const;
const walletTxInclude = { vendor: { select: { name: true } }, sponsor: { select: { name: true } } } as const;

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

  const transaction = await prisma.walletTransaction.create({
    data: {
      clientId,
      type: "SPONSOR_TAP",
      status: "COMPLETED",
      currency: wallet.currency,
      walletId: wallet.id,
      sponsorId: sponsor.id,
    },
    include: walletTxInclude,
  });

  return { ok: true, transaction: shapeWalletTransaction(transaction) };
}
