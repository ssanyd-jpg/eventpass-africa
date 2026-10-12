import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestEvent, createTestOrganization } from "@/lib/test-fixtures";
import { POST } from "@/app/api/staff/login/route";

function requestFor(body: unknown) {
  return new Request("http://localhost/api/staff/login", {
    method: "POST",
    headers: { "x-forwarded-for": `10.2.0.${Math.floor(Math.random() * 250) + 1}` },
    body: JSON.stringify(body),
  });
}

describe("POST /api/staff/login — phone-OTP (passwordHash: null) accounts", () => {
  it("returns a clean 401 instead of crashing on a null passwordHash", async () => {
    const organization = await createTestOrganization();
    const event = await createTestEvent(organization.id);
    const otpUser = await prisma.user.create({
      data: { name: "OTP Buyer", email: `otp-staff-${Date.now()}@test.local`, passwordHash: null },
    });

    const res = await POST(requestFor({ email: otpUser.email, password: "anything", eventId: event.id }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid credentials" });
  });
});
