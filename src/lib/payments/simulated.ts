import type { ChargeRequest, ChargeResult, PaymentProvider } from "./types";

/**
 * Today's actual checkout behavior: every charge is instantly "paid", no
 * real money moves. Active by default and whenever no real provider's
 * credentials are configured — see index.ts.
 */
export const simulatedProvider: PaymentProvider = {
  name: "SIMULATED",
  isConfigured: () => true,
  async initiateCharge(req: ChargeRequest): Promise<ChargeResult> {
    return {
      status: "PAID",
      reference: `SIM-${Date.now().toString(36).toUpperCase()}`,
      message: `Test mode — ${req.description} marked paid instantly, no real charge made.`,
    };
  },
};
