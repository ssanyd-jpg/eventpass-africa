import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Same mocking discipline as sms.test.ts: mock the SDK and the SMS
// fallback, not sendWhatsApp itself. normalizeTanzaniaPhone is left as the
// real implementation (via importOriginal) since it's what proves the
// +255 formatting actually reaches the provider call.
//
// vi.hoisted, not two separate `const mock* = vi.fn()` statements — see
// sync-handlers.test.ts's own comment on why: vi.mock() factories are
// hoisted above every other top-level statement, so with two separate mocks
// in one file a plain preceding const doesn't reliably stay initialized
// ahead of its factory (ReferenceError: Cannot access before initialization).
const { mockWhatsAppSend, mockSendSms } = vi.hoisted(() => ({
  mockWhatsAppSend: vi.fn(),
  mockSendSms: vi.fn(),
}));
vi.mock("africastalking", () => ({
  default: vi.fn().mockImplementation(() => ({
    WHATSAPP: { sendMessage: mockWhatsAppSend },
  })),
}));
vi.mock("@/lib/sms", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sms")>();
  return { ...actual, sendSMS: mockSendSms };
});

import { sendWhatsApp } from "@/lib/whatsapp";

describe("sendWhatsApp", () => {
  const originalApiKey = process.env.AT_API_KEY;
  const originalUsername = process.env.AT_WHATSAPP_USERNAME;
  const originalShortcode = process.env.AT_WHATSAPP_SHORTCODE;

  beforeEach(() => {
    mockWhatsAppSend.mockReset();
    mockWhatsAppSend.mockResolvedValue({});
    mockSendSms.mockReset();
    mockSendSms.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.AT_API_KEY;
    else process.env.AT_API_KEY = originalApiKey;
    if (originalUsername === undefined) delete process.env.AT_WHATSAPP_USERNAME;
    else process.env.AT_WHATSAPP_USERNAME = originalUsername;
    if (originalShortcode === undefined) delete process.env.AT_WHATSAPP_SHORTCODE;
    else process.env.AT_WHATSAPP_SHORTCODE = originalShortcode;
  });

  it("sends via Africa's Talking with the normalized +255 number when fully configured", async () => {
    process.env.AT_API_KEY = "test-key";
    process.env.AT_WHATSAPP_USERNAME = "test-wa-user";
    process.env.AT_WHATSAPP_SHORTCODE = "254700000000";

    const result = await sendWhatsApp({ to: "0712345678", message: "Your balance is low" });

    expect(result).toEqual({ ok: true, channel: "WHATSAPP" });
    expect(mockWhatsAppSend).toHaveBeenCalledWith({
      waNumber: "254700000000",
      phoneNumber: "+255712345678",
      body: { message: "Your balance is low" },
    });
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it("renders {{n}} templateParams into the message before sending", async () => {
    process.env.AT_API_KEY = "test-key";
    process.env.AT_WHATSAPP_USERNAME = "test-wa-user";
    process.env.AT_WHATSAPP_SHORTCODE = "254700000000";

    await sendWhatsApp({
      to: "0712345678",
      message: "Hi {{1}}, your balance is {{2}}",
      templateName: "low_balance",
      templateParams: ["Alice", "TZS 5,000"],
    });

    expect(mockWhatsAppSend).toHaveBeenCalledWith(
      expect.objectContaining({ body: { message: "Hi Alice, your balance is TZS 5,000" } })
    );
  });

  it("falls back to SMS when AT_WHATSAPP_USERNAME/AT_WHATSAPP_SHORTCODE are absent", async () => {
    process.env.AT_API_KEY = "test-key";
    delete process.env.AT_WHATSAPP_USERNAME;
    delete process.env.AT_WHATSAPP_SHORTCODE;

    const result = await sendWhatsApp({ to: "0712345678", message: "Hi" });

    expect(mockWhatsAppSend).not.toHaveBeenCalled();
    expect(mockSendSms).toHaveBeenCalledWith({ to: "0712345678", message: "Hi" });
    expect(result).toEqual({ ok: true, channel: "SMS" });
  });

  it("falls back to SMS when the WhatsApp send throws", async () => {
    process.env.AT_API_KEY = "test-key";
    process.env.AT_WHATSAPP_USERNAME = "test-wa-user";
    process.env.AT_WHATSAPP_SHORTCODE = "254700000000";
    mockWhatsAppSend.mockRejectedValue(new Error("template not approved"));

    const result = await sendWhatsApp({ to: "0712345678", message: "Hi" });

    expect(mockSendSms).toHaveBeenCalledWith({ to: "0712345678", message: "Hi" });
    expect(result).toEqual({ ok: true, channel: "SMS" });
  });

  it("surfaces the SMS fallback's own failure when both channels fail", async () => {
    process.env.AT_API_KEY = "test-key";
    process.env.AT_WHATSAPP_USERNAME = "test-wa-user";
    process.env.AT_WHATSAPP_SHORTCODE = "254700000000";
    mockWhatsAppSend.mockRejectedValue(new Error("template not approved"));
    mockSendSms.mockResolvedValue({ ok: false, error: "network error" });

    const result = await sendWhatsApp({ to: "0712345678", message: "Hi" });

    expect(result).toEqual({ ok: false, channel: "SMS", error: "network error" });
  });
});
