import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Pure unit test of the Resend adapter — no real network call, no test DB
// needed (this file never touches prisma). Mirrors how sync-handlers.test.ts
// mocks Airpay's own provider calls: mock the SDK, not sendEmail itself.
const mockSend = vi.fn();
vi.mock("resend", () => ({
  // A regular function, not an arrow function — email.ts calls `new
  // Resend(apiKey)`, and only a real function (not an arrow function) can
  // be invoked as a mock constructor.
  Resend: vi.fn().mockImplementation(function MockResend() {
    return { emails: { send: mockSend } };
  }),
}));

import { sendEmail, buildOrderConfirmationHtml } from "@/lib/email";

describe("sendEmail", () => {
  const originalKey = process.env.RESEND_API_KEY;
  const originalFrom = process.env.CHAAP_FROM_EMAIL;

  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({ data: { id: "test-id" }, error: null });
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalKey;
    if (originalFrom === undefined) delete process.env.CHAAP_FROM_EMAIL;
    else process.env.CHAAP_FROM_EMAIL = originalFrom;
  });

  it("falls back to logging instead of sending when RESEND_API_KEY is absent", async () => {
    delete process.env.RESEND_API_KEY;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await sendEmail({ to: "buyer@test.local", subject: "Hi", html: "<p>Hi</p>" });

    expect(result.ok).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("buyer@test.local"));
    logSpy.mockRestore();
  });

  it("sends via Resend, using CHAAP_FROM_EMAIL, when RESEND_API_KEY is present", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.CHAAP_FROM_EMAIL = "noreply@chaap-africa.com";

    const result = await sendEmail({ to: "buyer@test.local", subject: "Hi", html: "<p>Hi</p>", text: "Hi" });

    expect(result.ok).toBe(true);
    expect(mockSend).toHaveBeenCalledWith({
      from: "noreply@chaap-africa.com",
      to: "buyer@test.local",
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
    });
  });

  it("defaults the sender to noreply@chaap-africa.com when CHAAP_FROM_EMAIL is unset", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    delete process.env.CHAAP_FROM_EMAIL;

    await sendEmail({ to: "buyer@test.local", subject: "Hi", html: "<p>Hi</p>" });

    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ from: "noreply@chaap-africa.com" }));
  });

  it("returns ok:false (without throwing) when Resend reports an error", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    mockSend.mockResolvedValue({ data: null, error: { message: "invalid domain" } });

    const result = await sendEmail({ to: "buyer@test.local", subject: "Hi", html: "<p>Hi</p>" });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid domain");
  });
});

describe("buildOrderConfirmationHtml", () => {
  it("embeds a QR code image for every ticket code, including on a free (TZS 0) order", async () => {
    const html = await buildOrderConfirmationHtml({
      buyerName: "Asha Buyer",
      eventTitle: "Community Fun Run",
      totalFormatted: "TZS 0",
      ticketCodes: ["FREE-00001", "FREE-00002"],
    });

    // One hosted QR <img> per ticket code — this is the "QR code" the
    // bug report expects in every order confirmation, free orders included.
    // Hosted (not a data: URI) because Gmail blocks inline base64 images.
    expect(html.match(/<img src="[^"]*\/api\/tickets\/FREE-00001\/qr\.png"/g)).toHaveLength(1);
    expect(html.match(/<img src="[^"]*\/api\/tickets\/FREE-00002\/qr\.png"/g)).toHaveLength(1);
    expect(html).not.toContain("data:image/png;base64,");
    expect(html).toContain("FREE-00001");
    expect(html).toContain("FREE-00002");
    expect(html).toContain("TZS 0");
  });
});
