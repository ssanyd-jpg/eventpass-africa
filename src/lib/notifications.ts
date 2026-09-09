import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { sendSMS } from "@/lib/sms";

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
  | "VENDOR_SETTLEMENT_PROCESSED";

export type NotificationChannel = "EMAIL" | "SMS";

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
  const providerConfigured =
    (input.channel === "EMAIL" && !!process.env.RESEND_API_KEY) ||
    (input.channel === "SMS" && !!process.env.AT_API_KEY && !!process.env.AT_USERNAME);

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

  const result =
    input.channel === "EMAIL"
      ? await sendEmail({
          to: input.recipient,
          subject: input.subject,
          html: input.html ?? `<p>${input.body.replace(/\n/g, "<br />")}</p>`,
          text: input.body,
        })
      : await sendSMS({ to: input.recipient, message: input.body });

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
