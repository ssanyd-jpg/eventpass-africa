import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Same mocking discipline as email.test.ts/whatsapp.test.ts: mock the SDKs,
// not sendNotification/sendEmail/sendWhatsApp themselves.
const { mockEmailSend, mockWhatsAppSend } = vi.hoisted(() => ({
  mockEmailSend: vi.fn(),
  mockWhatsAppSend: vi.fn(),
}));
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(function MockResend() {
    return { emails: { send: mockEmailSend } };
  }),
}));
vi.mock("africastalking", () => ({
  default: vi.fn().mockImplementation(() => ({
    WHATSAPP: { sendMessage: mockWhatsAppSend },
    SMS: { send: vi.fn() },
  })),
}));

import { prisma } from "@/lib/prisma";
import { POST, OPTIONS } from "@/app/api/leads/route";

const ALLOWED_ORIGIN = "https://chaap.africa";

let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `10.77.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
}

function postRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/leads", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/leads", () => {
  const originalEnv = {
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    AT_API_KEY: process.env.AT_API_KEY,
    AT_WHATSAPP_USERNAME: process.env.AT_WHATSAPP_USERNAME,
    AT_WHATSAPP_SHORTCODE: process.env.AT_WHATSAPP_SHORTCODE,
    CHAAP_OWNER_PHONE: process.env.CHAAP_OWNER_PHONE,
  };

  beforeEach(() => {
    mockEmailSend.mockReset();
    mockEmailSend.mockResolvedValue({ data: { id: "email-id" }, error: null });
    mockWhatsAppSend.mockReset();
    mockWhatsAppSend.mockResolvedValue({});
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.AT_API_KEY = "test-at-key";
    process.env.AT_WHATSAPP_USERNAME = "test-wa-user";
    process.env.AT_WHATSAPP_SHORTCODE = "254700000000";
    process.env.CHAAP_OWNER_PHONE = "0712000999";
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("creates a lead, emails hello@chaap.africa, and WhatsApps the owner", async () => {
    const ip = uniqueIp();
    const response = await POST(
      postRequest(
        { name: "Asha Mwangi", phone: "0712345678", email: "asha@example.com", eventName: "Summit Cup 2026", expectedAttendance: "100-250" },
        { "x-forwarded-for": ip, origin: ALLOWED_ORIGIN }
      )
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
    const { id } = await response.json();
    expect(id).toBeTruthy();

    const lead = await prisma.marketingLead.findUniqueOrThrow({ where: { id } });
    expect(lead).toMatchObject({
      name: "Asha Mwangi",
      phone: "0712345678",
      email: "asha@example.com",
      eventName: "Summit Cup 2026",
      expectedAttendance: "100-250",
      source: "website",
      status: "NEW",
    });

    expect(mockEmailSend).toHaveBeenCalledTimes(1);
    expect(mockEmailSend.mock.calls[0][0]).toMatchObject({ to: "hello@chaap.africa" });
    expect(mockWhatsAppSend).toHaveBeenCalledTimes(1);
    expect(mockWhatsAppSend.mock.calls[0][0]).toMatchObject({ phoneNumber: "+255712000999" });

    const logs = await prisma.notificationLog.findMany({ where: { type: "MARKETING_LEAD_RECEIVED", subject: `New lead: ${lead.name}` } });
    expect(logs.map((l) => l.channel).sort()).toEqual(["EMAIL", "WHATSAPP"]);
    expect(logs.every((l) => l.status === "SENT")).toBe(true);
  });

  it("accepts a submission with only the required fields", async () => {
    const ip = uniqueIp();
    const response = await POST(postRequest({ name: "Bare Minimum", phone: "0700000000" }, { "x-forwarded-for": ip }));

    expect(response.status).toBe(201);
    const { id } = await response.json();
    const lead = await prisma.marketingLead.findUniqueOrThrow({ where: { id } });
    expect(lead.email).toBeNull();
    expect(lead.eventName).toBeNull();
    expect(lead.expectedAttendance).toBeNull();
  });

  it("rejects a submission missing the required name", async () => {
    const ip = uniqueIp();
    const response = await POST(postRequest({ phone: "0712345678" }, { "x-forwarded-for": ip }));

    expect(response.status).toBe(400);
    const { error } = await response.json();
    expect(error).toMatch(/name/i);
    expect(mockEmailSend).not.toHaveBeenCalled();
  });

  it("rejects a submission missing the required phone", async () => {
    const ip = uniqueIp();
    const response = await POST(postRequest({ name: "No Phone" }, { "x-forwarded-for": ip }));

    expect(response.status).toBe(400);
    const { error } = await response.json();
    expect(error).toMatch(/phone/i);
  });

  it("rejects an invalid email while leaving other optional fields alone", async () => {
    const ip = uniqueIp();
    const response = await POST(postRequest({ name: "Bad Email", phone: "0712345678", email: "not-an-email" }, { "x-forwarded-for": ip }));

    expect(response.status).toBe(400);
    const { error } = await response.json();
    expect(error).toMatch(/email/i);
  });

  it("rate-limits after 5 submissions from the same IP within the window", async () => {
    const ip = uniqueIp();
    for (let i = 0; i < 5; i++) {
      const response = await POST(postRequest({ name: `Lead ${i}`, phone: "0712345678" }, { "x-forwarded-for": ip }));
      expect(response.status).toBe(201);
    }

    const sixth = await POST(postRequest({ name: "Lead 6", phone: "0712345678" }, { "x-forwarded-for": ip }));
    expect(sixth.status).toBe(429);
    const { error } = await sixth.json();
    expect(error).toMatch(/too many/i);
  });

  it("rejects a cross-origin request from a disallowed origin", async () => {
    const ip = uniqueIp();
    const response = await POST(
      postRequest({ name: "Evil Corp", phone: "0712345678" }, { "x-forwarded-for": ip, origin: "https://evil.example.com" })
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await prisma.marketingLead.count({ where: { name: "Evil Corp" } })).toBe(0);
  });

  it("allows a request with no Origin header at all (same-origin / server-to-server)", async () => {
    const ip = uniqueIp();
    const response = await POST(postRequest({ name: "No Origin Header", phone: "0712345678" }, { "x-forwarded-for": ip }));
    expect(response.status).toBe(201);
  });

  it("still returns 201 when CHAAP_OWNER_PHONE isn't set, skipping only the owner WhatsApp", async () => {
    delete process.env.CHAAP_OWNER_PHONE;
    const ip = uniqueIp();

    const response = await POST(postRequest({ name: "No Owner Phone", phone: "0712345678" }, { "x-forwarded-for": ip }));

    expect(response.status).toBe(201);
    expect(mockEmailSend).toHaveBeenCalledTimes(1);
    expect(mockWhatsAppSend).not.toHaveBeenCalled();
  });
});

describe("OPTIONS /api/leads", () => {
  function optionsRequest(origin: string | null) {
    return new Request("http://localhost/api/leads", {
      method: "OPTIONS",
      headers: origin ? { origin } : {},
    });
  }

  it("answers an allowed origin's preflight with the CORS headers", async () => {
    const response = await OPTIONS(optionsRequest(ALLOWED_ORIGIN));
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("rejects a disallowed origin's preflight", async () => {
    const response = await OPTIONS(optionsRequest("https://evil.example.com"));
    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
