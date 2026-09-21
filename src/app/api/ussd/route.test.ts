import { describe, expect, it, vi, afterEach } from "vitest";

// Pure unit test of the endpoint's auth gate and response shape — the menu
// itself is covered against the real test database in src/lib/ussd.test.ts,
// so handleUssd is mocked here while verifyUssdSecret stays real (via
// importOriginal), since the secret check is exactly what's under test.
// vi.hoisted() — see whatsapp.test.ts's comment.
const { mockHandleUssd } = vi.hoisted(() => ({ mockHandleUssd: vi.fn() }));
vi.mock("@/lib/ussd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ussd")>();
  return { ...actual, handleUssd: mockHandleUssd };
});

import { POST } from "@/app/api/ussd/route";

function ussdRequest(headers: Record<string, string> = {}, fields: Record<string, string> = {}) {
  return new Request("http://localhost/api/ussd", {
    method: "POST",
    headers,
    body: new URLSearchParams({
      sessionId: "ATUid_abc123",
      serviceCode: "*384*123#",
      phoneNumber: "+255712345678",
      text: "",
      ...fields,
    }),
  });
}

describe("POST /api/ussd", () => {
  const originalSecret = process.env.AT_USSD_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.AT_USSD_SECRET;
    else process.env.AT_USSD_SECRET = originalSecret;
    mockHandleUssd.mockReset();
  });

  it("rejects a request with no secret header", async () => {
    process.env.AT_USSD_SECRET = "test-ussd-secret";
    const response = await POST(ussdRequest());
    expect(response.status).toBe(401);
    expect(mockHandleUssd).not.toHaveBeenCalled();
  });

  it("rejects a request with the wrong secret", async () => {
    process.env.AT_USSD_SECRET = "test-ussd-secret";
    const response = await POST(ussdRequest({ "x-at-ussd-secret": "wrong-secret" }));
    expect(response.status).toBe(401);
    expect(mockHandleUssd).not.toHaveBeenCalled();
  });

  it("rejects every request when AT_USSD_SECRET isn't configured, even with a header present", async () => {
    delete process.env.AT_USSD_SECRET;
    const response = await POST(ussdRequest({ "x-at-ussd-secret": "undefined" }));
    expect(response.status).toBe(401);
    expect(mockHandleUssd).not.toHaveBeenCalled();
  });

  it("answers a valid request as text/plain, passing the form fields to the menu", async () => {
    process.env.AT_USSD_SECRET = "test-ussd-secret";
    mockHandleUssd.mockResolvedValue("CON Welcome to Chaap\n1. Check balance");

    const response = await POST(ussdRequest({ "x-at-ussd-secret": "test-ussd-secret" }, { text: "2*5000" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("CON Welcome to Chaap\n1. Check balance");
    expect(mockHandleUssd).toHaveBeenCalledWith({
      sessionId: "ATUid_abc123",
      serviceCode: "*384*123#",
      phoneNumber: "+255712345678",
      text: "2*5000",
    });
  });

  it("ends the session with a message instead of a 500 when the menu throws", async () => {
    process.env.AT_USSD_SECRET = "test-ussd-secret";
    mockHandleUssd.mockRejectedValue(new Error("db down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(ussdRequest({ "x-at-ussd-secret": "test-ussd-secret" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("END Something went wrong. Please try again later");
    consoleError.mockRestore();
  });
});
