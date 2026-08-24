import type { PaymentProvider } from "./types";
import { simulatedProvider } from "./simulated";
import { airpayProvider } from "./airpay";

/**
 * The single place that decides which payment provider is active. Nothing
 * in the app currently calls this (see the "Payment adapter" note in
 * README for why checkout isn't wired to it yet) — it exists so that
 * finishing the Airpay Tanzania integration later is a matter of setting
 * env vars, not redesigning checkout.
 */
export function getActivePaymentProvider(): PaymentProvider {
  if (airpayProvider.isConfigured()) return airpayProvider;
  return simulatedProvider;
}

export type { ChargeRequest, ChargeResult, ChargeStatus, PaymentProvider } from "./types";
