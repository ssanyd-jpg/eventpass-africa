import { Resend } from "resend";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  // Session 39 — Case A organiser branding. Overrides only the display name
  // shown in the recipient's inbox ("Organiser Name <noreply@chaap-...>");
  // the actual sending address stays the shared, domain-verified one, so
  // this needs no per-organiser email infrastructure — a "from" display
  // name can vary per-send on a shared verified sending domain. Omitted (or
  // the organiser hasn't set a display name) falls back to the existing
  // plain address, unchanged from before this field existed.
  fromName?: string;
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

  const fromAddress = process.env.CHAAP_FROM_EMAIL || "noreply@chaap-africa.com";
  // Only wrap a bare address — if CHAAP_FROM_EMAIL was itself set to a
  // "Name <address>" form, that operator-level choice wins over a
  // per-organiser override rather than silently double-wrapping it.
  const from = input.fromName && !fromAddress.includes("<") ? `${input.fromName} <${fromAddress}>` : fromAddress;

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

// Shared brand palette for transactional email — deliberately a light shell
// (not the product's dark "sunset" theme): email clients' dark-mode
// re-tinting is inconsistent enough that a dark-background email can end up
// with dark text on a dark background in some inboxes, so every transactional
// email renders on white with the brand accent/ink as highlight colours
// instead of inheriting the in-app palette directly.
const EMAIL_ACCENT = "#ff9142";
const EMAIL_INK = "#1a1310";
const EMAIL_MUTED = "#6b6560";
const EMAIL_BORDER = "#ece6e1";

// Every transactional email shares this shell (logo, card, footer) so the
// brand shows up consistently whether it's an order confirmation, a password
// reset, or any future notification — see buildOrderConfirmationHtml and
// buildPasswordResetHtml below, the two current callers.
function renderEmailShell(input: { baseUrl: string; previewText: string; bodyHtml: string }): string {
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#f5f1ee;padding:32px 16px;">
      <!-- Preview text shown in inbox lists, hidden in the opened email -->
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${input.previewText}</div>
      <div style="max-width:480px;margin:0 auto;">
        <div style="text-align:center;margin-bottom:20px;">
          <img src="${input.baseUrl}/chaap-icon-192.png" width="40" height="40" alt="Chaap" style="border-radius:10px;display:inline-block;" />
          <div style="margin-top:8px;font-size:12px;font-weight:700;letter-spacing:0.14em;color:${EMAIL_INK};">CHAAP</div>
        </div>
        <div style="background:#ffffff;border:1px solid ${EMAIL_BORDER};border-radius:16px;padding:28px 24px;color:${EMAIL_INK};">
          ${input.bodyHtml}
        </div>
        <p style="margin:20px 0 0;text-align:center;font-size:12px;line-height:1.6;color:${EMAIL_MUTED};">
          Chaap — East Africa's event platform.<br />
          Need help? Just reply to this email.
        </p>
      </div>
    </div>
  `;
}

// QR images are hosted at /api/tickets/[code]/qr.png rather than inlined as
// data: URIs — Gmail blocks inline base64 images in HTML mail, rendering an
// empty box instead of the QR. That route encodes the same raw ticket code
// (not a URL) via the same `qrcode` package, matching TicketQr.tsx, the
// buyer-facing in-app equivalent of this same QR.
export async function buildOrderConfirmationHtml(input: {
  buyerName: string;
  eventTitle: string;
  totalFormatted: string;
  ticketCodes: string[];
  extraLines?: string[];
}): Promise<string> {
  const baseUrl = process.env.NEXTAUTH_URL ?? "";
  const ticketsHtml = input.ticketCodes
    .map(
      (code) => `
        <div style="margin:16px 0;padding:18px;text-align:center;background:#fbf9f7;border:1px dashed ${EMAIL_BORDER};border-radius:12px;">
          <img src="${baseUrl}/api/tickets/${encodeURIComponent(code)}/qr.png" width="160" height="160" alt="QR code for ticket ${code}" style="display:block;margin:0 auto;border-radius:8px;" />
          <p style="font-family:'SF Mono',Consolas,monospace;font-size:18px;font-weight:700;letter-spacing:2px;margin:14px 0 0;color:${EMAIL_INK};">${code}</p>
        </div>
      `
    )
    .join("");
  const extraHtml = (input.extraLines ?? [])
    .map((line) => `<p style="color:${EMAIL_MUTED};font-size:13px;margin:4px 0;">${line}</p>`)
    .join("");

  const bodyHtml = `
    <p style="margin:0 0 4px;font-size:12px;font-weight:700;letter-spacing:0.08em;color:${EMAIL_ACCENT};text-transform:uppercase;">You're going!</p>
    <h1 style="margin:0 0 16px;font-size:21px;font-weight:800;color:${EMAIL_INK};">${input.eventTitle}</h1>
    <p style="margin:0 0 4px;font-size:14px;color:${EMAIL_INK};">Hi ${input.buyerName}, your order is confirmed.</p>
    <p style="margin:0 0 20px;font-size:14px;color:${EMAIL_INK};">Total paid: <strong>${input.totalFormatted}</strong></p>
    ${ticketsHtml}
    ${extraHtml}
    <p style="margin:20px 0 0;font-size:13px;color:${EMAIL_MUTED};">Show a QR code above, or its code, at the gate for entry.</p>
  `;

  return renderEmailShell({
    baseUrl,
    previewText: `Your tickets for ${input.eventTitle} are confirmed.`,
    bodyHtml,
  });
}

// Branded counterpart to the plain-text PASSWORD_RESET notification body
// built in src/app/api/password-reset/request/route.ts — passed as this
// same request's `html` field so the email matches every other branded
// email instead of sendNotification's generic `<p>${body}</p>` fallback.
export function buildPasswordResetHtml(input: { userName: string; resetUrl: string }): string {
  const baseUrl = process.env.NEXTAUTH_URL ?? "";
  const bodyHtml = `
    <p style="margin:0 0 4px;font-size:12px;font-weight:700;letter-spacing:0.08em;color:${EMAIL_ACCENT};text-transform:uppercase;">Password reset</p>
    <h1 style="margin:0 0 16px;font-size:21px;font-weight:800;color:${EMAIL_INK};">Reset your Chaap password</h1>
    <p style="margin:0 0 20px;font-size:14px;color:${EMAIL_INK};">Hi ${input.userName}, use the button below to set a new password. This link expires in 1 hour.</p>
    <p style="margin:0 0 24px;text-align:center;">
      <a href="${input.resetUrl}" style="display:inline-block;background:${EMAIL_ACCENT};color:${EMAIL_INK};font-weight:700;font-size:14px;padding:12px 28px;border-radius:999px;text-decoration:none;">Reset password</a>
    </p>
    <p style="margin:0;font-size:12px;color:${EMAIL_MUTED};">If you didn't request this, you can safely ignore this email — your password is unchanged.</p>
  `;

  return renderEmailShell({
    baseUrl,
    previewText: "Reset your Chaap password.",
    bodyHtml,
  });
}
