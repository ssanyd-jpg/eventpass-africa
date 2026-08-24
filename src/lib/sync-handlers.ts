import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { generateTicketCode, slugify, formatCents } from "@/lib/format";
import { sendNotification } from "@/lib/notifications";
import { CURRENCY_CODES, DEFAULT_CURRENCY } from "@/lib/currency";

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

export async function handleCreateEvent(userId: string, payload: any) {
  const clientId = String(payload.eventId);

  const existing = await prisma.event.findUnique({
    where: { clientId },
    include: { ticketTypes: true, organizer: { select: { name: true } } },
  });
  if (existing) {
    return { ok: true, event: shapeEvent(existing, existing.organizer.name) };
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
      organizerId: userId,
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
    include: { ticketTypes: true, organizer: { select: { name: true } } },
  });

  return { ok: true, event: shapeEvent(created, created.organizer.name) };
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
    organizerId: e.organizerId,
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
    },
  });
  if (existing) {
    return { ok: true, order: shapeOrder(existing), oversold: existing.status === "NEEDS_REVIEW", ticketTypeUpdates: [] };
  }

  const event = await resolveEventId(String(payload.eventId), payload.eventClientId);
  if (!event) {
    return { ok: false, retry: true, reason: "EVENT_NOT_SYNCED_YET" };
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

    const created = await tx.order.create({
      data: {
        clientId,
        status: oversold ? "NEEDS_REVIEW" : "PAID",
        totalCents,
        currency: event.currency,
        userId,
        eventId: event.id,
        items: { create: orderItemsData },
        tickets: { create: ticketsData },
      },
      include: {
        items: { include: { ticketType: true } },
        tickets: { include: { ticketType: true } },
        event: { select: { id: true, clientId: true, title: true } },
      },
    });

    return created;
  });

  const buyer = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
  if (buyer) {
    await sendNotification({
      type: "ORDER_CONFIRMATION",
      channel: "EMAIL",
      recipient: buyer.email,
      subject: `Your tickets for ${event.title}`,
      body: `Hi ${buyer.name}, your order for ${event.title} is confirmed. Total: ${formatCents(totalCents, event.currency)}. Ticket code(s): ${order.tickets.map((t) => t.code).join(", ")}.`,
    });
  }

  return { ok: true, order: shapeOrder(order), oversold, ticketTypeUpdates };
}

export async function handleCheckIn(payload: any) {
  const code = String(payload.ticketCode);
  const ticket = await prisma.ticket.findUnique({ where: { code } });
  if (!ticket) {
    return { ok: false, retry: true, reason: "TICKET_NOT_FOUND" };
  }
  if (ticket.checkedIn) {
    return { ok: true, ticket: { ...ticket, checkedInAt: ticket.checkedInAt?.toISOString() ?? null }, alreadyCheckedIn: true };
  }
  const updated = await prisma.ticket.update({
    where: { id: ticket.id },
    data: { checkedIn: true, checkedInAt: new Date(payload.scannedAt ?? Date.now()) },
  });
  return {
    ok: true,
    ticket: { ...updated, checkedInAt: updated.checkedInAt?.toISOString() ?? null },
  };
}

export async function handleAddMobileMoneyAccount(userId: string, payload: any) {
  const account = await prisma.mobileMoneyAccount.create({
    data: {
      provider: String(payload.provider),
      phoneNumber: String(payload.phoneNumber),
      accountName: String(payload.accountName),
      isDefault: true,
      organizerId: userId,
    },
  });
  await prisma.mobileMoneyAccount.updateMany({
    where: { organizerId: userId, id: { not: account.id } },
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
      organizerId: account.organizerId,
    },
  };
}

export async function handleEditEvent(userId: string, payload: any) {
  const event = await resolveEventId(String(payload.eventId), payload.eventClientId);
  if (!event) {
    return { ok: false, retry: true, reason: "EVENT_NOT_SYNCED_YET" };
  }
  if (event.organizerId !== userId) {
    return { ok: false, reason: "FORBIDDEN" };
  }

  const data: Record<string, unknown> = {};
  for (const key of ["title", "description", "category", "venue", "city", "imageUrl"] as const) {
    if (payload[key] !== undefined) data[key] = String(payload[key]);
  }
  if (payload.startsAt !== undefined) data.startsAt = new Date(payload.startsAt);

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

  const updated = await prisma.event.update({
    where: { id: event.id },
    data,
    include: { ticketTypes: true, organizer: { select: { name: true } } },
  });

  return { ok: true, event: shapeEvent(updated, updated.organizer.name) };
}

export async function handleCancelEvent(userId: string, payload: any) {
  const event = await resolveEventId(String(payload.eventId), payload.eventClientId);
  if (!event) {
    return { ok: false, retry: true, reason: "EVENT_NOT_SYNCED_YET" };
  }
  if (event.organizerId !== userId) {
    return { ok: false, reason: "FORBIDDEN" };
  }

  const updated = await prisma.event.update({
    where: { id: event.id },
    data: { status: "CANCELLED" },
    include: { ticketTypes: true, organizer: { select: { name: true } } },
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

  return { ok: true, event: shapeEvent(updated, updated.organizer.name) };
}

export async function handleRefundOrder(userId: string, payload: any) {
  const orderId = String(payload.orderId);
  const orderClientId = payload.orderClientId as string | null | undefined;

  const fullInclude = {
    items: { include: { ticketType: true } },
    tickets: { include: { ticketType: true } },
    event: { select: { id: true, clientId: true, title: true, organizerId: true } },
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
  if (order.event.organizerId !== userId) {
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
  });

  await sendNotification({
    type: "REFUND_ISSUED",
    channel: "EMAIL",
    recipient: order.user.email,
    subject: `Your order for ${order.event.title} has been refunded`,
    body: `Hi ${order.user.name}, your order for ${order.event.title} (${formatCents(order.totalCents, order.currency)}) has been refunded and your ticket(s) are no longer valid for entry.`,
  });

  return { ok: true, order: shapeOrder(updated), ticketTypeUpdates };
}
