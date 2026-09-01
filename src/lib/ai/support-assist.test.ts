import { afterEach, describe, expect, it, vi } from "vitest";
import * as claude from "./claude";
import { draftSupportReply, categorizeSupportTicket } from "./support-assist";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("draftSupportReply", () => {
  it("passes the thread through and returns the trimmed draft", async () => {
    vi.spyOn(claude, "callClaude").mockResolvedValue({ ok: true, text: "  Sure, here's your refund.  " });
    const result = await draftSupportReply(
      { subject: "Refund?", body: "Can I get a refund?" },
      [{ body: "Let me check.", isFromOrganizer: true }]
    );
    expect(result).toEqual({ ok: true, draft: "Sure, here's your refund." });
  });

  it("propagates a NOT_CONFIGURED failure from callClaude unchanged", async () => {
    vi.spyOn(claude, "callClaude").mockResolvedValue({ ok: false, reason: "NOT_CONFIGURED", message: "no key" });
    const result = await draftSupportReply({ subject: "s", body: "b" }, []);
    expect(result).toEqual({ ok: false, reason: "NOT_CONFIGURED", message: "no key" });
  });
});

describe("categorizeSupportTicket", () => {
  it("parses a well-formed 'Category | Priority' response", async () => {
    vi.spyOn(claude, "callClaude").mockResolvedValue({ ok: true, text: "Billing | HIGH" });
    const result = await categorizeSupportTicket("Charged twice", "I was charged twice for one ticket.");
    expect(result).toEqual({ ok: true, category: "Billing", priority: "HIGH" });
  });

  it("tolerates extra whitespace and a trailing newline", async () => {
    vi.spyOn(claude, "callClaude").mockResolvedValue({ ok: true, text: "  Technical  |  LOW  \n" });
    const result = await categorizeSupportTicket("App won't load", "The app is stuck loading.");
    expect(result).toEqual({ ok: true, category: "Technical", priority: "LOW" });
  });

  it("rejects a category outside the closed set rather than guessing", async () => {
    vi.spyOn(claude, "callClaude").mockResolvedValue({ ok: true, text: "Complaint | HIGH" });
    const result = await categorizeSupportTicket("s", "b");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("UNPARSEABLE");
  });

  it("rejects a priority outside the closed set rather than guessing", async () => {
    vi.spyOn(claude, "callClaude").mockResolvedValue({ ok: true, text: "Billing | URGENT" });
    const result = await categorizeSupportTicket("s", "b");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("UNPARSEABLE");
  });

  it("rejects a response with no separator at all", async () => {
    vi.spyOn(claude, "callClaude").mockResolvedValue({ ok: true, text: "This ticket is about billing." });
    const result = await categorizeSupportTicket("s", "b");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("UNPARSEABLE");
  });

  it("propagates a REQUEST_FAILED failure from callClaude unchanged", async () => {
    vi.spyOn(claude, "callClaude").mockResolvedValue({ ok: false, reason: "REQUEST_FAILED", message: "HTTP 500" });
    const result = await categorizeSupportTicket("s", "b");
    expect(result).toEqual({ ok: false, reason: "REQUEST_FAILED", message: "HTTP 500" });
  });
});
