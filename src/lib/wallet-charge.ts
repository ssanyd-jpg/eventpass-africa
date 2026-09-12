// Session 15 — split payment needs a live AirPay STK push and can never
// work offline (there's no webhook, only a poll-based confirm — see
// payments/airpay.ts). Pulled out of the wallet charge terminal page as a
// small pure decision so the offline-messaging choice is directly
// testable, same convention as resolveGateSignal in ticket-types.ts.
export function resolveOfflineChargeMessage(localBalanceCents: number | null, amountCents: number): string {
  if (localBalanceCents !== null && localBalanceCents < amountCents) {
    return "Split payment requires a connection — ask the attendee to top up first at a top-up station.";
  }
  return "Charging requires an online connection.";
}
