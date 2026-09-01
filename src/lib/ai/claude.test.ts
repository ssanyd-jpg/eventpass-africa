import { afterEach, describe, expect, it, vi } from "vitest";
import { callClaude, isClaudeConfigured } from "./claude";

// No real network calls in this file — every case stubs global fetch (or
// leaves ANTHROPIC_API_KEY unset entirely) so this suite runs without a key
// and without touching the actual Claude API, matching this codebase's rule
// that no CI job may require a live third-party credential.

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
});

describe("isClaudeConfigured", () => {
  it("is false when ANTHROPIC_API_KEY is unset", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(isClaudeConfigured()).toBe(false);
  });

  it("is true once ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
    expect(isClaudeConfigured()).toBe(true);
  });
});

describe("callClaude", () => {
  it("short-circuits with NOT_CONFIGURED and never calls fetch when unset", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await callClaude({ system: "sys", prompt: "hello" });

    expect(result).toEqual({ ok: false, reason: "NOT_CONFIGURED", message: "ANTHROPIC_API_KEY is not set on this deployment." });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("parses a well-formed text response", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ content: [{ type: "text", text: "Drafted description." }] }),
      })
    );

    const result = await callClaude({ system: "sys", prompt: "hello" });
    expect(result).toEqual({ ok: true, text: "Drafted description." });
  });

  it("surfaces REQUEST_FAILED on a non-2xx status", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: { message: "invalid x-api-key" } }),
      })
    );

    const result = await callClaude({ system: "sys", prompt: "hello" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("REQUEST_FAILED");
      expect(result.message).toContain("HTTP 401");
    }
  });

  it("surfaces REQUEST_FAILED on a non-JSON body", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "<html>not json</html>",
      })
    );

    const result = await callClaude({ system: "sys", prompt: "hello" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("REQUEST_FAILED");
      expect(result.message).toContain("non-JSON response");
    }
  });

  it("surfaces REQUEST_FAILED when the response has no text content block", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ content: [{ type: "tool_use" }] }),
      })
    );

    const result = await callClaude({ system: "sys", prompt: "hello" });
    expect(result).toEqual({ ok: false, reason: "REQUEST_FAILED", message: "Claude response had no text content." });
  });

  it("surfaces REQUEST_FAILED when fetch itself throws (network error)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND")));

    const result = await callClaude({ system: "sys", prompt: "hello" });
    expect(result).toEqual({ ok: false, reason: "REQUEST_FAILED", message: "getaddrinfo ENOTFOUND" });
  });
});
