import AfricasTalking from "africastalking";
import { normalizeTanzaniaPhone, sendSMS } from "@/lib/sms";

export interface SendWhatsAppInput {
  to: string;
  message: string;
  // Positional {{n}} placeholders in `message`, e.g. templateParams:
  // ["Alice", "TZS 5,000"] replaces {{1}} and {{2}}. templateName labels
  // which message shape a caller is sending; Africa's Talking's real
  // template product needs Meta-approved WhatsApp templates this project
  // doesn't have, so every message — templated or not — is still sent as
  // plain WhatsApp text via sendMessage, never createTemplate.
  templateName?: string;
  templateParams?: string[];
}

export interface SendWhatsAppResult {
  ok: boolean;
  channel: "WHATSAPP" | "SMS";
  error?: string;
}

function renderTemplate(message: string, params?: string[]): string {
  if (!params || params.length === 0) return message;
  return params.reduce((text, value, i) => text.replaceAll(`{{${i + 1}}}`, value), message);
}

/**
 * WhatsApp send via Africa's Talking's WhatsApp Business API, mirroring
 * sendSMS's/sendEmail's single-provider-adapter shape. Falls back to
 * sendSMS (src/lib/sms.ts, which normalizes the same Tanzania numbers and
 * has its own "no credentials, just log" fallback) whenever WhatsApp isn't
 * configured or the send itself throws — WhatsApp is the primary channel
 * in Tanzania, but every notification still needs to land somewhere.
 *
 * As of this writing, Africa's Talking's WhatsApp *sandbox* endpoint is
 * listed as "coming soon" (only the live endpoint exists) — so until
 * AT_WHATSAPP_USERNAME/AT_WHATSAPP_SHORTCODE point at a real production
 * WhatsApp number, every send here falls through to SMS. That's expected
 * in local dev, not a bug.
 */
export async function sendWhatsApp(input: SendWhatsAppInput): Promise<SendWhatsAppResult> {
  const apiKey = process.env.AT_API_KEY;
  const username = process.env.AT_WHATSAPP_USERNAME;
  const waNumber = process.env.AT_WHATSAPP_SHORTCODE;
  const message = renderTemplate(input.message, input.templateParams);

  if (apiKey && username && waNumber) {
    try {
      const client = AfricasTalking({ apiKey, username });
      await client.WHATSAPP.sendMessage({
        waNumber,
        phoneNumber: normalizeTanzaniaPhone(input.to),
        body: { message },
      });
      return { ok: true, channel: "WHATSAPP" };
    } catch (err) {
      console.error("[whatsapp] Africa's Talking send failed, falling back to SMS", err);
    }
  }

  const fallback = await sendSMS({ to: input.to, message });
  return { ok: fallback.ok, channel: "SMS", error: fallback.error };
}
