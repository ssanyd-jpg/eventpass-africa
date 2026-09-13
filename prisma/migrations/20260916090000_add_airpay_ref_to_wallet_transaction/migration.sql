-- Session 18: AirPay payment reconciliation — a distinct column for the
-- AirPay reference saved once a top-up is CONFIRMED, separate from
-- providerReference (Chaap's own merchant order id, set at initiation).
ALTER TABLE "WalletTransaction" ADD COLUMN "airpayRef" TEXT;
