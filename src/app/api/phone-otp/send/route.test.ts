import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { normalizeTanzaniaPhone } from "@/lib/sms";
import { POST } from "@/app/api/phone-otp/send/route";

// vitest.config.ts forces AT_API_KEY/AT_USERNAME to "" for every test run,
// so sendNotification always takes its LOGGED fallback here — assert
// against NotificationLog rather than mocking sendSMS (see phone-otp.test.ts).

let ipCounter = 0;
function freshIp() {
  ipCounter += 1;
  return `10.1.0.${ipCounter}`;
}

function requestFor(phone: string, ip: string) {
  return new Request("http://localhost/api/phone-otp/send", {
    method: "POST",
    headers: { "x-forwarded-for": ip },
    body: JSON.stringify({ phone }),
  });
}

function freshPhone() {
  return `07${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
}

describe("POST /api/phone-otp/send", () => {
  it("rejects a missing/too-short phone", async () => {
    const res = await POST(requestFor("123", freshIp()));
    expect(res.status).toBe(400);
  });

  it("sends a code on a fresh phone+IP", async () => {
    const phone = freshPhone();
    const res = await POST(requestFor(phone, freshIp()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const count = await prisma.notificationLog.count({
      where: { type: "PHONE_VERIFICATION_CODE", recipient: normalizeTanzaniaPhone(phone) },
    });
    expect(count).toBe(1);
  });

  it("enforces the resend cooldown for the same phone, independent of the IP", async () => {
    const phone = freshPhone();
    const first = await POST(requestFor(phone, freshIp()));
    expect(first.status).toBe(200);

    // Different IP, same phone, immediately after — cooldown still blocks it.
    const second = await POST(requestFor(phone, freshIp()));
    expect(second.status).toBe(429);

    const count = await prisma.notificationLog.count({
      where: { type: "PHONE_VERIFICATION_CODE", recipient: normalizeTanzaniaPhone(phone) },
    });
    expect(count).toBe(1);
  });

  it("blocks the per-phone bucket after 5 requests/hour, independent of the per-call cooldown", async () => {
    const phone = freshPhone();
    const normalized = normalizeTanzaniaPhone(phone);
    // Each call uses a fresh IP (so the IP bucket never trips). The 60s
    // resend cooldown lives inside generateAndSendPhoneCode and would
    // otherwise block every one of these before the bucket (limit 5) could
    // ever be exercised in a fast-running test — mark the just-created code
    // consumed after each call so only the thing actually under test, the
    // checkRateLimit bucket, decides the outcome.
    for (let i = 0; i < 5; i++) {
      const res = await POST(requestFor(phone, freshIp()));
      expect(res.status).toBe(200);
      await prisma.phoneVerificationCode.updateMany({
        where: { phone: normalized, consumedAt: null },
        data: { consumedAt: new Date() },
      });
    }
    const sixth = await POST(requestFor(phone, freshIp()));
    expect(sixth.status).toBe(429);
  });

  it("blocks the per-IP bucket after 8 requests/10min, across different phones", async () => {
    const ip = freshIp();
    for (let i = 0; i < 8; i++) {
      const res = await POST(requestFor(freshPhone(), ip));
      expect(res.status).toBe(200);
    }
    const ninth = await POST(requestFor(freshPhone(), ip));
    expect(ninth.status).toBe(429);
  });
});
