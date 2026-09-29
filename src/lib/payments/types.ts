export interface ChargeRequest {
  orderClientId: string;
  amountCents: number;
  /** E.164-ish local format, e.g. "255712345678" — required by real mobile money providers for STK push. */
  phoneNumber?: string;
  /** Which network to charge — "MPESA" | "TIGO" | "AIRTEL" (Airpay Tanzania's only confirmed bankcodes today; HALOTEL/HaloPesa and T-Pesa aren't available yet — see mapNetworkToBankcode in airpay.ts) — unset defaults to MPESA. */
  mobileNetwork?: string;
  description: string;
}

export type ChargeStatus = "PAID" | "PENDING" | "FAILED";

export interface ChargeResult {
  status: ChargeStatus;
  /** Provider's reference for this charge — used to reconcile the webhook callback. */
  reference: string;
  message?: string;
}

export interface PaymentProvider {
  name: string;
  /** True once real credentials are configured; false means calls fall through to the simulator. */
  isConfigured(): boolean;
  initiateCharge(req: ChargeRequest): Promise<ChargeResult>;
}
