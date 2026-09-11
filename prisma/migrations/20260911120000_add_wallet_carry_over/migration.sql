-- Session 11: multi-event wristband balance carry-over.

ALTER TABLE "Event" ADD COLUMN "endsAt" TIMESTAMP(3);
ALTER TABLE "Event" ADD COLUMN "carryOverEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Wallet" ADD COLUMN "carryOverSourceWalletId" TEXT;
ALTER TABLE "Wallet" ADD COLUMN "carryOverredAt" TIMESTAMP(3);

CREATE INDEX "Wallet_carryOverSourceWalletId_idx" ON "Wallet"("carryOverSourceWalletId");
