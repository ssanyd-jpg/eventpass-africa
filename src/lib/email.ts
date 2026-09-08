import { Resend } from "resend";
import QRCode from "qrcode";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface SendEmailResult {
  ok: boolean;
  error?: string;
}

/**
 * Single provider adapter for email — mirrors sendSMS's shape (see
 * src/lib/sms.ts). Logs to console instead of sending whenever
 * RESEND_API_KEY isn't set, matching sendNotification's own "no
 * credentials, just log" fallback (src/lib/notifications.ts) — that
 * function is still the actual choke point every caller goes through; this
 * is just the provider call it makes once a real key exists.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    console.log(`[email:LOGGED] to=${input.to} subject="${input.subject}"`);
    return { ok: true };
  }

  const from = process.env.CHAAP_FROM_EMAIL || "noreply@chaap-africa.com";

  try {
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });
    if (error) {
      console.error("[email] Resend send failed", error);
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (err) {
    console.error("[email] Resend send failed", err);
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

// Inline QR images as data URIs rather than real attachments — no
// multipart/attachment plumbing needed, and every mainstream mail client
// renders a data: <img> in an HTML email fine. Reuses the same `qrcode`
// package (and the same "encode the raw code, not a URL" choice) as
// TicketQr.tsx, the buyer-facing in-app equivalent of this same QR.
export async function buildOrderConfirmationHtml(input: {
  buyerName: string;
  eventTitle: string;
  totalFormatted: string;
  ticketCodes: string[];
  extraLines?: string[];
}): Promise<string> {
  const qrImages = await Promise.all(
    input.ticketCodes.map((code) => QRCode.toDataURL(code, { margin: 1, width: 180 }))
  );
  const ticketsHtml = input.ticketCodes
    .map(
      (code, i) => `
        <div style="margin:20px 0;text-align:center;">
          <img src="${qrImages[i]}" width="180" height="180" alt="QR code for ticket ${code}" style="display:block;margin:0 auto;border-radius:8px;" />
          <p style="font-family:monospace,monospace;font-size:20px;font-weight:bold;letter-spacing:2px;margin:10px 0 0;">${code}</p>
        </div>
      `
    )
    .join("");
  const extraHtml = (input.extraLines ?? [])
    .map((line) => `<p style="color:#666;font-size:13px;margin:4px 0;">${line}</p>`)
    .join("");

  return `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;color:#111;">
      <h2 style="margin:0 0 4px;">You're going!</h2>
      <p style="color:#666;margin:0 0 16px;">${input.eventTitle}</p>
      <p>Hi ${input.buyerName}, your order is confirmed. Total: <strong>${input.totalFormatted}</strong>.</p>
      ${ticketsHtml}
      ${extraHtml}
      <p style="color:#999;font-size:12px;margin-top:16px;">Show a QR code above, or its code, at the gate for entry.</p>
    </div>
  `;
}
