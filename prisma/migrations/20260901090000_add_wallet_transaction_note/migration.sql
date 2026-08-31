-- Sponsor lead capture: a freeform note a staff member can attach to a
-- SPONSOR_TAP transaction at scan time. Purely additive.
ALTER TABLE "WalletTransaction" ADD COLUMN "note" TEXT;

CREATE INDEX "WalletTransaction_sponsorId_type_createdAt_idx" ON "WalletTransaction"("sponsorId", "type", "createdAt");
