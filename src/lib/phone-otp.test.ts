import { describe, expect, it, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestUser } from "@/lib/test-fixtures";
import { normalizeTanzaniaPhone } from "@/lib/sms";
import {
  generateAndSendPhoneCode,
  verifyAndConsumePhoneCode,
  resolveOrCreateOtpUser,
  OTP_MAX_ATTEMPTS,
} from "@/lib/phone-otp";

// vitest.config.ts forces AT_API_KEY/AT_USERNAME to "" for every test run
// (see its own comment — avoids a real Africa's Talking round-trip per
// test), so sendNotification always takes its LOGGED fallback here, never
// the real/mocked sendSMS. Read the code straight out of NotificationLog
// instead of mocking sendSMS — simpler, and matches the house pattern
// (pending-topups.test.ts asserts the same LOGGED fallback).
async function codeFromNotificationLog(phone: string): Promise<string> {
  const log = await prisma.notificationLog.findFirst({
    where: { type: "PHONE_VERIFICATION_CODE", recipient: phone },
    orderBy: { createdAt: "desc" },
  });
  const match = log?.body.match(/\d{6}/);
  if (!match) throw new Error(`No 6-digit code found in NotificationLog for ${phone}: ${log?.body}`);
  return match[0];
}

afterEach(async () => {
  // Same Neon connection-pool drain as ticket-pool.test.ts/wallet-transfer.test.ts.
  await new Promise((resolve) => setTimeout(resolve, 500));
});

function testPhone() {
  return `07${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
}

describe("generateAndSendPhoneCode", () => {
  it("stores only a hash of the code, never the code itself", async () => {
    const phone = testPhone();
    await generateAndSendPhoneCode(phone);

    const row = await prisma.phoneVerificationCode.findFirst({
      where: { phone: normalizeTanzaniaPhone(phone) },
      orderBy: { createdAt: "desc" },
    });
    expect(row).toBeTruthy();
    const code = await codeFromNotificationLog(normalizeTanzaniaPhone(phone));
    expect(row!.codeHash).not.toBe(code);
    expect(row!.codeHash).toHaveLength(64); // sha256 hex
  });

  it("enforces a resend cooldown", async () => {
    const phone = testPhone();
    const first = await generateAndSendPhoneCode(phone);
    expect(first.ok).toBe(true);

    const second = await generateAndSendPhoneCode(phone);
    expect(second).toEqual({ ok: false, reason: "COOLDOWN" });

    const count = await prisma.notificationLog.count({
      where: { type: "PHONE_VERIFICATION_CODE", recipient: normalizeTanzaniaPhone(phone) },
    });
    expect(count).toBe(1);
  });
});

describe("verifyAndConsumePhoneCode", () => {
  it("accepts the right code", async () => {
    const phone = testPhone();
    await generateAndSendPhoneCode(phone);
    const code = await codeFromNotificationLog(normalizeTanzaniaPhone(phone));

    const result = await verifyAndConsumePhoneCode(phone, code);
    expect(result).toEqual({ ok: true });
  });

  it("rejects a wrong code and increments attempts", async () => {
    const phone = testPhone();
    await generateAndSendPhoneCode(phone);

    const result = await verifyAndConsumePhoneCode(phone, "000000");
    expect(result).toEqual({ ok: false, reason: "INVALID" });

    const row = await prisma.phoneVerificationCode.findFirst({
      where: { phone: normalizeTanzaniaPhone(phone) },
      orderBy: { createdAt: "desc" },
    });
    expect(row!.attempts).toBe(1);
  });

  it("locks out after OTP_MAX_ATTEMPTS wrong guesses, even with the right code on the next try", async () => {
    const phone = testPhone();
    await generateAndSendPhoneCode(phone);
    const code = await codeFromNotificationLog(normalizeTanzaniaPhone(phone));

    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      await verifyAndConsumePhoneCode(phone, "000000");
    }

    const result = await verifyAndConsumePhoneCode(phone, code);
    expect(result).toEqual({ ok: false, reason: "TOO_MANY_ATTEMPTS" });
  });

  it("rejects an expired code", async () => {
    const phone = testPhone();
    await generateAndSendPhoneCode(phone);
    const code = await codeFromNotificationLog(normalizeTanzaniaPhone(phone));

    await prisma.phoneVerificationCode.updateMany({
      where: { phone: normalizeTanzaniaPhone(phone) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const result = await verifyAndConsumePhoneCode(phone, code);
    expect(result).toEqual({ ok: false, reason: "EXPIRED" });
  });

  it("never lets the same code verify twice, and reports ALREADY_USED rather than a generic INVALID", async () => {
    const phone = testPhone();
    await generateAndSendPhoneCode(phone);
    const code = await codeFromNotificationLog(normalizeTanzaniaPhone(phone));

    const first = await verifyAndConsumePhoneCode(phone, code);
    expect(first).toEqual({ ok: true });

    const second = await verifyAndConsumePhoneCode(phone, code);
    expect(second).toEqual({ ok: false, reason: "ALREADY_USED" });
  });

  it("reports ALREADY_USED even for a wrong code, once the latest code is consumed", async () => {
    const phone = testPhone();
    await generateAndSendPhoneCode(phone);
    const code = await codeFromNotificationLog(normalizeTanzaniaPhone(phone));
    await verifyAndConsumePhoneCode(phone, code);

    // A retry with a mistyped/stale code after the real one already
    // succeeded should still say "already used", not "incorrect" — that's
    // the actual true state, and attempts shouldn't be charged against a
    // code that's no longer live.
    const result = await verifyAndConsumePhoneCode(phone, "000000");
    expect(result).toEqual({ ok: false, reason: "ALREADY_USED" });

    const row = await prisma.phoneVerificationCode.findFirst({
      where: { phone: normalizeTanzaniaPhone(phone) },
      orderBy: { createdAt: "desc" },
    });
    expect(row!.attempts).toBe(0);
  });

  it("rejects when no code was ever sent for this phone", async () => {
    const result = await verifyAndConsumePhoneCode(testPhone(), "123456");
    expect(result).toEqual({ ok: false, reason: "INVALID" });
  });
});

describe("resolveOrCreateOtpUser", () => {
  it("creates a new User + personal attendee org for a never-before-seen phone", async () => {
    const phone = testPhone();
    const result = await resolveOrCreateOtpUser(phone, "Jane Buyer", `jane-${Date.now()}@test.local`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.user.name).toBe("Jane Buyer");
    expect(result.user.role).toBe("USER");

    const dbUser = await prisma.user.findUnique({ where: { id: result.user.id } });
    expect(dbUser?.passwordHash).toBeNull();

    const membership = await prisma.organizationMembership.findUnique({
      where: { userId: result.user.id },
      include: { organization: true },
    });
    expect(membership?.role).toBe("OWNER");
    expect(membership?.organization.isAttendeeOrg).toBe(true);
  });

  it("rejects when a new phone has no name/email on file", async () => {
    const result = await resolveOrCreateOtpUser(testPhone(), "", "");
    expect(result).toEqual({ ok: false, reason: "MISSING_NAME_OR_EMAIL" });
  });

  it("rejects creating a new account when the email is already taken", async () => {
    const existing = await createTestUser();
    const result = await resolveOrCreateOtpUser(testPhone(), "Someone Else", existing.email);
    expect(result).toEqual({ ok: false, reason: "EMAIL_TAKEN" });
  });

  it("signs into an existing phone-only account without overwriting its name/email", async () => {
    const phone = testPhone();
    const first = await resolveOrCreateOtpUser(phone, "Original Name", `orig-${Date.now()}@test.local`);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // A different household member typing the same shared phone, with a
    // different name/email — must sign into the SAME account, unchanged.
    const second = await resolveOrCreateOtpUser(phone, "Someone Else Entirely", "different@test.local");
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.user.id).toBe(first.user.id);
    expect(second.user.name).toBe("Original Name");
    expect(second.user.email).toBe(first.user.email);
  });

  it("refuses to sign into an existing password-protected account via OTP", async () => {
    const phone = testPhone();
    const existing = await createTestUser();
    // resolveOrCreateOtpUser looks up by normalizeTanzaniaPhone(phone) —
    // the fixture must store the same normalized form or the lookup won't
    // find it, which would silently fall through to "create new" instead.
    await prisma.user.update({ where: { id: existing.id }, data: { phone: normalizeTanzaniaPhone(phone) } });

    const result = await resolveOrCreateOtpUser(phone, "Attacker", "attacker@test.local");
    expect(result).toEqual({ ok: false, reason: "ACCOUNT_HAS_PASSWORD" });
  });
});
