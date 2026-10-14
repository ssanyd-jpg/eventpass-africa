import { createHash, randomInt } from "crypto";
import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/notifications";
import { normalizeTanzaniaPhone } from "@/lib/sms";
import { createPersonalOrganization } from "@/lib/organizations";

export const OTP_CODE_TTL_MS = 5 * 60 * 1000; // 5 min — long enough for SMS delivery lag + typing, short enough to bound brute force
export const OTP_MAX_ATTEMPTS = 5; // against a 1,000,000-possibility code, on top of the rate limits in the send route and the "buyer-otp" provider
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // prevents SMS-bombing a number from the UI's own resend button

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export type SendPhoneCodeResult = { ok: true } | { ok: false; reason: "COOLDOWN" };

// Deliberately the 6th hand-rolled hash-token implementation in this
// codebase (password reset, vendor/sponsor magic links, ticket transfer,
// org invite all do their own version) rather than a new shared
// abstraction — out of scope for this feature. Unlike those, this one
// tracks `attempts`: a 6-digit code is brute-forceable in a way a 32-byte
// random token isn't, so it needs its own shape (see PhoneVerificationCode's
// schema comment).
export async function generateAndSendPhoneCode(rawPhone: string): Promise<SendPhoneCodeResult> {
  const phone = normalizeTanzaniaPhone(rawPhone);

  const latest = await prisma.phoneVerificationCode.findFirst({
    where: { phone },
    orderBy: { createdAt: "desc" },
  });
  if (latest && !latest.consumedAt && Date.now() - latest.createdAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
    return { ok: false, reason: "COOLDOWN" };
  }

  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  await prisma.phoneVerificationCode.create({
    data: { phone, codeHash: hashCode(code), expiresAt: new Date(Date.now() + OTP_CODE_TTL_MS) },
  });

  await sendNotification({
    type: "PHONE_VERIFICATION_CODE",
    channel: "SMS",
    recipient: phone,
    subject: "Your Chaap verification code",
    body: `Your Chaap verification code is ${code}. It expires in 5 minutes.`,
  });

  // Opportunistic cleanup — same self-trim pattern as checkRateLimit, no cron needed.
  if (Math.random() < 0.01) {
    prisma.phoneVerificationCode
      .deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } } })
      .catch(() => {});
  }

  return { ok: true };
}

export type VerifyPhoneCodeResult =
  | { ok: true }
  | { ok: false; reason: "INVALID" | "EXPIRED" | "TOO_MANY_ATTEMPTS" | "ALREADY_USED" };

// Validates + consumes atomically, same reasoning as consumeVendorMagicLinkToken:
// a code is single-use, so the check and the consuming must happen in one
// transaction or two concurrent verify attempts could both succeed.
export async function verifyAndConsumePhoneCode(rawPhone: string, code: string): Promise<VerifyPhoneCodeResult> {
  const phone = normalizeTanzaniaPhone(rawPhone);
  const codeHash = hashCode(code);

  return prisma.$transaction(async (tx) => {
    // Deliberately the latest row regardless of consumed state (not
    // `where: { consumedAt: null }` like before) — a verify attempt that
    // lands after the latest code was already consumed (a double-submit,
    // or a second tab) needs to be told exactly that via ALREADY_USED,
    // rather than falling through to the same generic INVALID a genuinely
    // wrong/never-requested code gets. See the login page's error mapping.
    const row = await tx.phoneVerificationCode.findFirst({
      where: { phone },
      orderBy: { createdAt: "desc" },
    });

    if (!row) return { ok: false, reason: "INVALID" as const };
    if (row.consumedAt) return { ok: false, reason: "ALREADY_USED" as const };
    if (row.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, reason: "TOO_MANY_ATTEMPTS" as const };
    if (row.expiresAt < new Date()) return { ok: false, reason: "EXPIRED" as const };

    if (row.codeHash !== codeHash) {
      await tx.phoneVerificationCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
      return { ok: false, reason: "INVALID" as const };
    }

    await tx.phoneVerificationCode.update({ where: { id: row.id }, data: { consumedAt: new Date() } });
    return { ok: true as const };
  });
}

export type ResolveOtpUserResult =
  | { ok: true; user: { id: string; name: string; email: string; role: string } }
  | { ok: false; reason: "MISSING_NAME_OR_EMAIL" | "EMAIL_TAKEN" | "ACCOUNT_HAS_PASSWORD" };

// Called from the "buyer-otp" provider's authorize() in auth.ts, once a
// code has already verified — pulled out as its own function (rather than
// left inline in the NextAuth config, unlike vendor/sponsor-magic-link's
// simpler find-only authorize()) specifically so this, the actual new
// behavior this feature introduces, is unit-testable without standing up
// NextAuth's own request-handling stack.
export async function resolveOrCreateOtpUser(
  phone: string,
  name: string,
  email: string
): Promise<ResolveOtpUserResult> {
  const normalizedPhone = normalizeTanzaniaPhone(phone);
  let user = await prisma.user.findUnique({ where: { phone: normalizedPhone } });

  // Deliberate security choice: OTP never signs into an existing
  // password-protected account, even though phone is opportunistically
  // captured at checkout (see sync-handlers.ts) with no verification of who
  // currently controls that number — letting OTP alone unlock an existing
  // password account would let phone-number control (e.g. a SIM swap)
  // bypass a password entirely. Only phone-only accounts are OTP-reachable.
  if (user && user.passwordHash) {
    return { ok: false, reason: "ACCOUNT_HAS_PASSWORD" };
  }

  if (!user) {
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName || !trimmedEmail) {
      return { ok: false, reason: "MISSING_NAME_OR_EMAIL" };
    }
    if (await prisma.user.findUnique({ where: { email: trimmedEmail } })) {
      return { ok: false, reason: "EMAIL_TAKEN" };
    }
    user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { name: trimmedName, email: trimmedEmail, phone: normalizedPhone, passwordHash: null },
      });
      await createPersonalOrganization(tx, created.id, created.name, { isAttendeeOrg: true });
      return created;
    });
  }
  // Existing phone-only account: sign into it as-is. The freshly typed
  // name/email are discarded, never used to overwrite the real profile — a
  // different household member typing a shared phone must not be able to
  // rename/re-email the original account.

  return { ok: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
}
