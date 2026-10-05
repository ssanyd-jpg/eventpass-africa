import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { sendSMS } from "@/lib/sms";
import { sendWhatsApp } from "@/lib/whatsapp";

export type NotificationType =
  | "ORDER_CONFIRMATION"
  | "PASSWORD_RESET"
  | "EVENT_CANCELLED"
  | "REFUND_ISSUED"
  | "ORGANIZATION_INVITE"
  | "ORGANIZER_BROADCAST"
  | "TICKET_TRANSFER"
  | "SUPPORT_TICKET_CREATED"
  | "WITHDRAWAL_REQUESTED"
  | "WITHDRAWAL_DECIDED"
  | "ORDER_PAYMENT_FAILED"
  | "WRISTBAND_PROVISIONED"
  | "LOW_WALLET_BALANCE"
  | "VENDOR_MAGIC_LINK"
  | "VENDOR_SETTLEMENT_PROCESSED"
  | "SPONSOR_MAGIC_LINK"
  // Session 24
  | "WALLET_TOPUP_CONFIRMED"
  | "EVENT_REMINDER"
  // Session 26
  | "WAITLIST_SPOT_AVAILABLE"
  // Session 29
  | "DENSITY_ALERT"
  // Session 30
  | "VOLUNTEER_INVITED"
  // Session 32
  | "TICKET_RESALE"
  // Session 33
  | "LOYALTY_REWARD"
  // Session 28
  | "DIRECT_SALE_RECEIPT"
  // Session 37
  | "WALLET_TRANSFER_SENT"
  | "WALLET_TRANSFER_RECEIVED"
  // Post-event WhatsApp memory recap (organiser-triggered — see
  // post-event-memory-data.ts)
  | "POST_EVENT_MEMORY"
  // Season ticket / membership management — see season-pass.ts/
  // season-renewal.ts. SEASON_PASS_RENEWAL_DECLINED isn't part of the
  // spec's literal 3-type list but is needed for declineRenewal's own
  // WhatsApp acknowledgement to have a distinct, correct type.
  | "SEASON_PASS_PURCHASED"
  | "SEASON_PASS_RENEWAL_OFFERED"
  | "SEASON_PASS_RENEWED"
  | "SEASON_PASS_RENEWAL_DECLINED"
  // Chaap Ads marketplace — an organiser's own freeform WhatsApp broadcast
  // message to previous attendees (see sendBroadcast in chaap-ads.ts). One
  // type for the whole product, unlike SEASON_PASS_*'s per-template split,
  // since the body here is organiser-authored, not a fixed template.
  | "AD_BROADCAST"
  // Event WhatsApp group — see src/lib/whatsapp-group.ts.
  | "WHATSAPP_GROUP_INVITE_SENT"
  | "WHATSAPP_GROUP_ARCHIVED"
  // Compassionate close-out sent to any still-WAITING waitlist entry once
  // its event ends or is cancelled — see sendWaitlistClosureNotifications
  // in src/lib/waitlist.ts.
  | "WAITLIST_CLOSURE"
  // Fired once per ticket type, the moment it first reaches capacity (see
  // handleSellTickets) — tells the org OWNER to raise quantity or add a new
  // ticket type before the organiser's own dashboard callout (see
  // SoldOutCallout.tsx) would otherwise be their only signal.
  | "TICKET_TYPE_SOLD_OUT";

export type NotificationChannel = "EMAIL" | "SMS" | "WHATSAPP";

interface SendNotificationInput {
  type: NotificationType;
  channel: NotificationChannel;
  recipient: string;
  subject: string;
  body: string;
  // EMAIL only — rich version of `body`. Optional so every existing
  // plain-text caller keeps working unchanged: sendEmail gets a minimal
  // wrap of `body` when this is omitted.
  html?: string;
  // Session 39 — Case A organiser branding. EMAIL only, optional: when a
  // caller passes the event/order's organizationId, the send uses that
  // organisation's displayName (if any) as the email's "from" display name
  // instead of Chaap's. Omitted, or the org has no displayName set, is
  // unchanged from before this field existed. Only wired up for
  // ORDER_CONFIRMATION today (see sync-handlers.ts) — every other
  // notification type is equally eligible to pass this later.
  organizationId?: string;
}

/**
 * Single choke point for every outbound notification. Every caller
 * (checkout, password reset, event cancellation, refunds, wristband
 * provisioning, low-balance warnings) stays the same regardless of whether
 * a real provider is configured — only this function's internals change.
 * Without RESEND_API_KEY (email) or AT_API_KEY+AT_USERNAME (SMS), every
 * call still lands in NotificationLog only, visible in /admin so a pilot
 * admin can manually relay a password reset link or order confirmation —
 * the original dev-mode behavior, preserved exactly for whichever channel
 * isn't configured.
 */
export async function sendNotification(input: SendNotificationInput) {
  // WHATSAPP is "configured" if either a real WhatsApp send or its SMS
  // fallback could actually go out — sendWhatsApp itself picks between
  // them (see src/lib/whatsapp.ts), so this only needs to rule out the
  // "neither provider exists" case, matching EMAIL/SMS's own all-or-log gate.
  const providerConfigured =
    (input.channel === "EMAIL" && !!process.env.RESEND_API_KEY) ||
    (input.channel === "SMS" && !!process.env.AT_API_KEY && !!process.env.AT_USERNAME) ||
    (input.channel === "WHATSAPP" &&
      !!process.env.AT_API_KEY &&
      (!!(process.env.AT_WHATSAPP_USERNAME && process.env.AT_WHATSAPP_SHORTCODE) || !!process.env.AT_USERNAME));

  if (!providerConfigured) {
    return prisma.notificationLog.create({
      data: {
        type: input.type,
        channel: input.channel,
        recipient: input.recipient,
        subject: input.subject,
        body: input.body,
        status: "LOGGED",
      },
    });
  }

  const fromName =
    input.channel === "EMAIL" && input.organizationId
      ? (await prisma.organization.findUnique({ where: { id: input.organizationId }, select: { displayName: true } }))
          ?.displayName ?? undefined
      : undefined;

  const result =
    input.channel === "EMAIL"
      ? await sendEmail({
          to: input.recipient,
          subject: input.subject,
          html: input.html ?? `<p>${input.body.replace(/\n/g, "<br />")}</p>`,
          text: input.body,
          fromName,
        })
      : input.channel === "SMS"
        ? await sendSMS({ to: input.recipient, message: input.body })
        : await sendWhatsApp({ to: input.recipient, message: input.body });

  return prisma.notificationLog.create({
    data: {
      type: input.type,
      channel: input.channel,
      recipient: input.recipient,
      subject: input.subject,
      body: input.body,
      status: result.ok ? "SENT" : "FAILED",
    },
  });
}
