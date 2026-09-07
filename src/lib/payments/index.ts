import type { PaymentProvider } from "./types";
import { simulatedProvider } from "./simulated";
import { airpayProvider } from "./airpay";

/**
 * The single place that decides which payment provider is active. Called
 * from handleSellTickets (src/lib/sync-handlers.ts) for every AIRPAY_ONLINE
 * checkout — falls back to the simulator whenever the AIRPAY_* env vars
 * aren't all set, which is what makes the online/offline (Option C) split
 * work in dev and in a pilot org that hasn't finished Airpay onboarding yet.
 */
export function getActivePaymentProvider(): PaymentProvider {
  if (airpayProvider.isConfigured()) return airpayProvider;
  return simulatedProvider;
}

/**
 * Whether checkout should attempt a real online charge at all. "online"
 * requires both a fully-configured Airpay account (env vars — the same
 * check getActivePaymentProvider uses) and a connected device to reach it;
 * missing either one means checkout should stay on the instant-PAID,
 * reconcile-later offline path instead. Device connectivity isn't
 * something this module can observe on its own (it isn't browser code),
 * so the caller passes it in — see useOnlineStatus in src/lib/sync-engine.ts.
 */
export function getPaymentMode(deviceOnline: boolean): "online" | "offline" {
  return airpayProvider.isConfigured() && deviceOnline ? "online" : "offline";
}

export type { ChargeRequest, ChargeResult, ChargeStatus, PaymentProvider } from "./types";
