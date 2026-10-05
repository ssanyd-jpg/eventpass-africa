import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { POST } from "@/app/api/register/route";

// A fresh fake IP per call keeps every request inside this file off the
// route's own per-IP rate limit (5/10min) — same reasoning and pattern as
// src/app/api/vendor/magic-link/request/route.test.ts.
let ipCounter = 0;
function registerRequest(body: unknown) {
  ipCounter += 1;
  return new Request("http://localhost/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": `10.0.1.${ipCounter}` },
    body: JSON.stringify(body),
  });
}

async function orgFor(email: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    include: { organizationMembership: { include: { organization: true } } },
  });
  return user.organizationMembership!.organization;
}

describe("POST /api/register — attendee vs organiser signup", () => {
  it("attendee signup creates a personal org with isAttendeeOrg true", async () => {
    const email = `attendee-signup-${Date.now()}@example.com`;
    const res = await POST(
      registerRequest({ name: "Asha Buyer", email, password: "password123", accountType: "ATTENDEE" })
    );

    expect(res.status).toBe(201);
    const org = await orgFor(email);
    expect(org.isAttendeeOrg).toBe(true);
    expect(org.name).toBe("Asha Buyer's Organization");
  });

  it("organiser signup creates an org with isAttendeeOrg false, named after the company", async () => {
    const email = `organiser-signup-${Date.now()}@example.com`;
    const res = await POST(
      registerRequest({
        name: "Baraka Organiser",
        email,
        password: "password123",
        accountType: "ORGANISER",
        organizationName: "Baraka Live Events",
      })
    );

    expect(res.status).toBe(201);
    const org = await orgFor(email);
    expect(org.isAttendeeOrg).toBe(false);
    expect(org.name).toBe("Baraka Live Events");
  });

  it("rejects an organiser signup with no organisation name", async () => {
    const email = `organiser-no-name-${Date.now()}@example.com`;
    const res = await POST(
      registerRequest({ name: "No Company", email, password: "password123", accountType: "ORGANISER" })
    );

    expect(res.status).toBe(400);
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it("defaults to an attendee org when accountType is omitted (legacy/older client)", async () => {
    const email = `legacy-signup-${Date.now()}@example.com`;
    const res = await POST(registerRequest({ name: "Legacy Client", email, password: "password123" }));

    expect(res.status).toBe(201);
    const org = await orgFor(email);
    expect(org.isAttendeeOrg).toBe(true);
  });
});
