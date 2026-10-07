import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/notifications";
import { shapeOrder } from "@/lib/sync-handlers";
import { dictionaries, type Locale, type TranslationKey } from "@/lib/i18n";

// AirPay chargeback/reversal — a mobile money network can reverse a payment
// after Chaap already treated it as PAID (unlike PAYMENT_FAILED, which only
// ever happens before a PENDING order settles — see verifyAirpayOrder's own
// header comment on why there's no webhook for that initial leg). This one
// IS driven by a webhook, since AirPay has no poll endpoint for "did a past
// payment get reversed" — see the stub route at
// src/app/api/webhooks/payment/reversal/route.ts.
//
// No separate Ticket-level "SUSPENDED" status: handleCheckIn's gate on
// ticket.order.status (see sync-handlers.ts) already blocks every ticket on
// a REVERSED order from checking in, the same way it already does for
// PENDING/PAYMENT_FAILED/REFUNDED — a reversal always covers the whole
// order, so a second column that just mirrors order.status would be
// redundant state to keep in sync, not a real extra capability.

function translate(locale: Locale, key: TranslationKey, vars?: Record<string, string | number>): string {
  const template = dictionaries[locale][key] ?? dictionaries.en[key] ?? key;
  if (!vars) return template;
  return Object.entries(vars).reduce((acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)), template as string);
}

const fullInclude = {
  items: { include: { ticketType: true } },
  tickets: { include: { ticketType: true, ticketGroup: { select: { name: true } } } },
  event: { select: { id: true, clientId: true, title: true, organizationId: true } },
  user: { select: { name: true, phone: true } },
  registrationAnswers: { include: { question: true } },
} as const;

export type PaymentReversalResult =
  | { ok: false; reason: "ORDER_NOT_FOUND" }
  | { ok: true; skipped: true; reason: "ALREADY_REVERSED"; order: ReturnType<typeof shapeOrder> }
  | { ok: true; order: ReturnType<typeof shapeOrder> };

// Idempotent — a replayed webhook delivery for an order already REVERSED is
// a no-op rather than re-sending the WhatsApp pair below.
export async function handlePaymentReversal(orderId: string, airpayRef: string): Promise<PaymentReversalResult> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: fullInclude });
  if (!order) {
    return { ok: false, reason: "ORDER_NOT_FOUND" };
  }
  if (order.status === "REVERSED") {
    return { ok: true, skipped: true, reason: "ALREADY_REVERSED", order: shapeOrder(order) };
  }

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: { status: "REVERSED", providerMessage: `Reversed by provider (ref: ${airpayRef})` },
    include: fullInclude,
  });

  if (order.user.phone) {
    await sendNotification({
      type: "PAYMENT_REVERSED",
      channel: "WHATSAPP",
      recipient: order.user.phone,
      subject: `Payment reversed — ${order.id}`,
      body: translate("en", "paymentReversal.attendeeMessage", { event: order.event.title }),
    });
  }

  const owner = await prisma.organizationMembership.findFirst({
    where: { organizationId: order.event.organizationId, role: "OWNER" },
    include: { user: { select: { phone: true } } },
  });
  if (owner?.user.phone) {
    await sendNotification({
      type: "PAYMENT_REVERSED",
      channel: "WHATSAPP",
      recipient: owner.user.phone,
      subject: `Payment reversal (organiser) — ${order.id}`,
      body: translate("en", "paymentReversal.organiserMessage", {
        orderId: order.id,
        attendeeName: order.user.name,
      }),
    });
  }

  return { ok: true, order: shapeOrder(updated) };
}
