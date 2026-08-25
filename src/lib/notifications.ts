import { prisma } from "@/lib/prisma";

export type NotificationType =
  | "ORDER_CONFIRMATION"
  | "PASSWORD_RESET"
  | "EVENT_CANCELLED"
  | "REFUND_ISSUED"
  | "ORGANIZATION_INVITE";

export type NotificationChannel = "EMAIL" | "SMS";

interface SendNotificationInput {
  type: NotificationType;
  channel: NotificationChannel;
  recipient: string;
  subject: string;
  body: string;
}

/**
 * Single choke point for every outbound notification. No email/SMS provider
 * is configured yet (RESEND_API_KEY / AFRICASTALKING_API_KEY are unset), so
 * every call just lands in NotificationLog — visible in /admin so a pilot
 * admin can manually relay a password reset link or order confirmation.
 * Once real credentials exist, only this function needs to change; every
 * caller (checkout, password reset, event cancellation, refunds) stays the
 * same.
 */
export async function sendNotification(input: SendNotificationInput) {
  const providerConfigured =
    (input.channel === "EMAIL" && !!process.env.RESEND_API_KEY) ||
    (input.channel === "SMS" && !!process.env.AFRICASTALKING_API_KEY);

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

  // TODO: wire up Resend (email) / Africa's Talking (SMS) once credentials
  // are available. Until then providerConfigured is always false above.
  return prisma.notificationLog.create({
    data: {
      type: input.type,
      channel: input.channel,
      recipient: input.recipient,
      subject: input.subject,
      body: input.body,
      status: "SENT",
    },
  });
}
