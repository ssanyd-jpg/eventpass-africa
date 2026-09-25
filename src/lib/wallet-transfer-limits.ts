// Session 37 — wallet-transfer limits, kept in their own dependency-free
// module because the transfer page (a client component) needs them and
// wallet-transfer.ts pulls in Prisma and the notification senders.
//
// Amounts are in minor units, and these are TZS figures (TZS 1,000 and
// TZS 100,000). Transfers are TZS-only for now — see assertTransferable in
// wallet-transfer.ts — because the same numbers would be absurd in a
// two-decimal currency.
export const MIN_TRANSFER_CENTS = 1_000 * 100;
export const MAX_TRANSFER_CENTS = 100_000 * 100;
export const TRANSFER_EXPIRY_MS = 15 * 60 * 1000;
export const TRANSFER_CURRENCY = "TZS";
