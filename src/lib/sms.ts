import AfricasTalking from "africastalking";

export interface SendSmsInput {
  to: string;
  message: string;
}

export interface SendSmsResult {
  ok: boolean;
  error?: string;
}

// Tanzania-only normalization — the app's one supported SMS market (see
// NETWORKS in src/app/events/[slug]/page.tsx: MPESA/TIGO/AIRTEL/HALOTEL are
// all Tanzania-only mobile money networks). Accepts a local "0712345678"
// (what a buyer types at checkout), an already-prefixed "+255712345678", or
// a bare "255712345678", and always returns the E.164 form a real SMS
// provider expects.
export function normalizeTanzaniaPhone(raw: string): string {
  const digits = raw.trim().replace(/[^\d+]/g, "");
  if (digits.startsWith("+255")) return digits;
  if (digits.startsWith("255")) return `+${digits}`;
  if (digits.startsWith("0")) return `+255${digits.slice(1)}`;
  return `+255${digits}`;
}

/**
 * Single provider adapter for SMS — mirrors sendEmail's shape (see
 * src/lib/email.ts). Logs to console instead of sending whenever
 * AT_API_KEY/AT_USERNAME aren't both set, matching sendNotification's own
 * "no credentials, just log" fallback (src/lib/notifications.ts) — that
 * function is still the actual choke point every caller goes through; this
 * is just the provider call it makes once real credentials exist.
 */
export async function sendSMS(input: SendSmsInput): Promise<SendSmsResult> {
  const apiKey = process.env.AT_API_KEY;
  const username = process.env.AT_USERNAME;
  const to = normalizeTanzaniaPhone(input.to);

  if (!apiKey || !username) {
    console.log(`[sms:LOGGED] to=${to} message="${input.message}"`);
    return { ok: true };
  }

  try {
    const client = AfricasTalking({ apiKey, username });
    await client.SMS.send({ to: [to], message: input.message });
    return { ok: true };
  } catch (err) {
    console.error("[sms] Africa's Talking send failed", err);
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}
