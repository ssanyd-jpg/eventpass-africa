import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestEvent, createTestOrganization, createTestVendor } from "@/lib/test-fixtures";
import { POST } from "@/app/api/vendor/magic-link/request/route";

async function newEventWithVendor(contactEmail: string) {
  const organization = await createTestOrganization();
  const event = await createTestEvent(organization.id);
  const vendor = await createTestVendor(event.id, { status: "APPROVED" });
  await prisma.vendor.update({ where: { id: vendor.id }, data: { contactEmail } });
  return { event, vendor };
}

// A fresh fake IP per call keeps every request inside this test off the
// route's pre-existing per-IP bucket (5/10min), so only the email-keyed
// bucket under test here is ever at play.
let ipCounter = 0;
function requestFor(email: string, eventCode: string) {
  ipCounter += 1;
  return new Request("http://localhost/api/vendor/magic-link/request", {
    method: "POST",
    headers: { "x-forwarded-for": `10.0.0.${ipCounter}` },
    body: JSON.stringify({ email, eventCode }),
  });
}

describe("POST /api/vendor/magic-link/request — per-email rate limit", () => {
  it("stops sending a new link to the same email after 3 requests/hour, while the response stays generic throughout", async () => {
    const email = `vendor-rl-${Date.now()}@example.com`;
    const { event } = await newEventWithVendor(email);

    for (let i = 0; i < 3; i++) {
      const res = await POST(requestFor(email, event.slug));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
    expect(await prisma.notificationLog.count({ where: { recipient: email } })).toBe(3);

    // 4th request in the same window: still 200/{ok:true} (never reveals the
    // rate limit to the caller), but no 4th link is actually sent.
    const fourth = await POST(requestFor(email, event.slug));
    expect(fourth.status).toBe(200);
    expect(await fourth.json()).toEqual({ ok: true });
    expect(await prisma.notificationLog.count({ where: { recipient: email } })).toBe(3);
  });

  it("tracks a different email independently", async () => {
    const emailA = `vendor-rl-a-${Date.now()}@example.com`;
    const emailB = `vendor-rl-b-${Date.now()}@example.com`;
    const { event: eventA } = await newEventWithVendor(emailA);
    const { event: eventB } = await newEventWithVendor(emailB);

    for (let i = 0; i < 3; i++) {
      await POST(requestFor(emailA, eventA.slug));
    }
    // emailA is now exhausted; emailB, never touched, still goes through.
    const res = await POST(requestFor(emailB, eventB.slug));
    expect(res.status).toBe(200);
    expect(await prisma.notificationLog.count({ where: { recipient: emailB } })).toBe(1);
  });
});
