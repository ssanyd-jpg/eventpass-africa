-- Withdrawals need to record which mobile-money network to pay out on —
-- no real disbursement API exists, so the organizer pays the buyer out
-- manually after approving the request. Purely additive.
ALTER TABLE "WalletTransaction" ADD COLUMN "mobileNetwork" TEXT;
