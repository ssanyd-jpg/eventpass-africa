import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { getActivePaymentProvider } from "./index";
import { simulatedProvider } from "./simulated";

describe("getActivePaymentProvider", () => {
  // isConfigured() requires all seven Airpay credential vars — see
  // airpay-crypto.ts's readAirpayCredentials().
  const AIRPAY_VARS = [
    "AIRPAY_MERCHANT_ID",
    "AIRPAY_CLIENT_ID",
    "AIRPAY_CLIENT_SECRET",
    "AIRPAY_USERNAME",
    "AIRPAY_PASSWORD",
    "AIRPAY_SECRET",
    "AIRPAY_MERCHANT_DOMAIN",
  ] as const;
  const originalValues = Object.fromEntries(AIRPAY_VARS.map((k) => [k, process.env[k]]));

  beforeEach(() => {
    for (const k of AIRPAY_VARS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of AIRPAY_VARS) {
      const original = originalValues[k];
      if (original === undefined) delete process.env[k];
      else process.env[k] = original;
    }
  });

  it("falls back to the simulated provider when no real credentials are configured", () => {
    expect(getActivePaymentProvider().name).toBe("SIMULATED");
  });

  it("falls back to simulated when only some Airpay credentials are set", () => {
    process.env.AIRPAY_MERCHANT_ID = "test-merchant";
    process.env.AIRPAY_CLIENT_ID = "test-client";
    expect(getActivePaymentProvider().name).toBe("SIMULATED");
  });

  it("switches to Airpay once every credential is present", () => {
    for (const k of AIRPAY_VARS) process.env[k] = `test-${k.toLowerCase()}`;
    expect(getActivePaymentProvider().name).toBe("AIRPAY_TZ");
  });
});

describe("simulatedProvider", () => {
  it("always instantly reports the charge as PAID", async () => {
    const result = await simulatedProvider.initiateCharge({
      orderClientId: "local:abc",
      amountCents: 200000,
      description: "2x General Admission",
    });
    expect(result.status).toBe("PAID");
    expect(result.reference).toMatch(/^SIM-/);
  });
});
