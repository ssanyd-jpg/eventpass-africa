import { describe, expect, it } from "vitest";
import { checkLoginRateLimit, resetLoginRateLimit } from "@/lib/login-rate-limit";

describe("checkLoginRateLimit", () => {
  it("allows up to 5 attempts, then blocks the 6th, for a given email+IP pair", async () => {
    const email = `login-rl-${Date.now()}@example.com`;
    const ip = "203.0.113.10";

    for (let i = 0; i < 5; i++) {
      expect(await checkLoginRateLimit(email, ip)).toBe(true);
    }
    expect(await checkLoginRateLimit(email, ip)).toBe(false);
  });

  it("blocks an email once its own bucket is exhausted, even from a brand-new IP", async () => {
    const email = `login-rl-email-${Date.now()}@example.com`;
    for (let i = 0; i < 5; i++) {
      await checkLoginRateLimit(email, `203.0.113.${i}`);
    }
    expect(await checkLoginRateLimit(email, "203.0.113.99")).toBe(false);
  });

  it("blocks an IP once its own bucket is exhausted, even across different emails (credential stuffing)", async () => {
    const ip = "203.0.113.50";
    for (let i = 0; i < 5; i++) {
      await checkLoginRateLimit(`login-rl-stuff-${i}-${Date.now()}@example.com`, ip);
    }
    expect(await checkLoginRateLimit(`login-rl-stuff-last-${Date.now()}@example.com`, ip)).toBe(false);
  });
});

describe("resetLoginRateLimit", () => {
  it("clears both buckets so a successful login doesn't count against the next attempt", async () => {
    const email = `login-rl-reset-${Date.now()}@example.com`;
    const ip = "203.0.113.77";

    for (let i = 0; i < 5; i++) {
      await checkLoginRateLimit(email, ip);
    }
    expect(await checkLoginRateLimit(email, ip)).toBe(false);

    await resetLoginRateLimit(email, ip);

    expect(await checkLoginRateLimit(email, ip)).toBe(true);
  });
});
