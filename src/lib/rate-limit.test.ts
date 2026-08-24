import { describe, expect, it } from "vitest";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";

describe("checkRateLimit", () => {
  it("allows requests under the limit", async () => {
    const key = `test-${Date.now()}-${Math.random()}`;
    const result = await checkRateLimit(key, { limit: 3, windowMs: 60000 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });

  it("blocks once the limit is hit within the window", async () => {
    const key = `test-${Date.now()}-${Math.random()}`;
    await checkRateLimit(key, { limit: 2, windowMs: 60000 });
    await checkRateLimit(key, { limit: 2, windowMs: 60000 });
    const third = await checkRateLimit(key, { limit: 2, windowMs: 60000 });
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
  });

  it("tracks separate buckets independently", async () => {
    const keyA = `bucket-a-${Date.now()}`;
    const keyB = `bucket-b-${Date.now()}`;
    await checkRateLimit(keyA, { limit: 1, windowMs: 60000 });
    const resultA = await checkRateLimit(keyA, { limit: 1, windowMs: 60000 });
    const resultB = await checkRateLimit(keyB, { limit: 1, windowMs: 60000 });
    expect(resultA.allowed).toBe(false);
    expect(resultB.allowed).toBe(true);
  });
});

describe("clientIp", () => {
  it("reads the first address from x-forwarded-for", () => {
    const req = new Request("http://x", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } });
    expect(clientIp(req)).toBe("1.2.3.4");
  });

  it("falls back to 'unknown' when the header is missing", () => {
    const req = new Request("http://x");
    expect(clientIp(req)).toBe("unknown");
  });
});
