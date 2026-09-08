import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Pure unit test of the Africa's Talking adapter — no real network call, no
// test DB needed (this file never touches prisma). Mirrors email.test.ts's
// own mocking discipline: mock the SDK, not sendSMS itself.
const mockSmsSend = vi.fn();
vi.mock("africastalking", () => ({
  default: vi.fn().mockImplementation(() => ({
    SMS: { send: mockSmsSend },
  })),
}));

import { sendSMS, normalizeTanzaniaPhone } from "@/lib/sms";

describe("normalizeTanzaniaPhone", () => {
  it("prepends +255 to a local 0-prefixed number", () => {
    expect(normalizeTanzaniaPhone("0712345678")).toBe("+255712345678");
  });

  it("leaves an already-E.164 +255 number unchanged", () => {
    expect(normalizeTanzaniaPhone("+255712345678")).toBe("+255712345678");
  });

  it("adds a + to a bare 255-prefixed number", () => {
    expect(normalizeTanzaniaPhone("255712345678")).toBe("+255712345678");
  });

  it("strips spaces before normalizing a local number", () => {
    expect(normalizeTanzaniaPhone("0712 345 678")).toBe("+255712345678");
  });
});

describe("sendSMS", () => {
  const originalKey = process.env.AT_API_KEY;
  const originalUsername = process.env.AT_USERNAME;

  beforeEach(() => {
    mockSmsSend.mockReset();
    mockSmsSend.mockResolvedValue({});
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.AT_API_KEY;
    else process.env.AT_API_KEY = originalKey;
    if (originalUsername === undefined) delete process.env.AT_USERNAME;
    else process.env.AT_USERNAME = originalUsername;
  });

  it("falls back to logging instead of sending when AT_API_KEY/AT_USERNAME are absent", async () => {
    delete process.env.AT_API_KEY;
    delete process.env.AT_USERNAME;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await sendSMS({ to: "0712345678", message: "Hi" });

    expect(result.ok).toBe(true);
    expect(mockSmsSend).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("+255712345678"));
    logSpy.mockRestore();
  });

  it("still falls back when only one of the two required credentials is set", async () => {
    process.env.AT_API_KEY = "test-key";
    delete process.env.AT_USERNAME;

    const result = await sendSMS({ to: "0712345678", message: "Hi" });

    expect(result.ok).toBe(true);
    expect(mockSmsSend).not.toHaveBeenCalled();
  });

  it("sends via Africa's Talking with the normalized +255 number when both credentials are present", async () => {
    process.env.AT_API_KEY = "test-key";
    process.env.AT_USERNAME = "test-user";

    const result = await sendSMS({ to: "0712345678", message: "Your balance is low" });

    expect(result.ok).toBe(true);
    expect(mockSmsSend).toHaveBeenCalledWith({ to: ["+255712345678"], message: "Your balance is low" });
  });

  it("returns ok:false (without throwing) when the provider call rejects", async () => {
    process.env.AT_API_KEY = "test-key";
    process.env.AT_USERNAME = "test-user";
    mockSmsSend.mockRejectedValue(new Error("network error"));

    const result = await sendSMS({ to: "0712345678", message: "Hi" });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("network error");
  });
});
