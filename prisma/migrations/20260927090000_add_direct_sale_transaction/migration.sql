-- Session 28 — vendor terminal "Direct Sale": a mobile money charge to a
-- walk-up customer with no wristband, via an AirPay STK push. Standalone
-- table, purely additive — never touches Wallet/WalletTransaction/Credential.

CREATE TABLE "DirectSaleTransaction" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TZS',
    "customerPhone" TEXT NOT NULL,
    "mobileNetwork" TEXT NOT NULL,
    "airpayRef" TEXT,
    "providerReference" TEXT,
    "providerMessage" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "item" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "eventId" TEXT NOT NULL,
    "vendorUserId" TEXT NOT NULL,

    CONSTRAINT "DirectSaleTransaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DirectSaleTransaction_clientId_key" ON "DirectSaleTransaction"("clientId");
CREATE INDEX "DirectSaleTransaction_eventId_createdAt_idx" ON "DirectSaleTransaction"("eventId", "createdAt");
CREATE INDEX "DirectSaleTransaction_vendorUserId_createdAt_idx" ON "DirectSaleTransaction"("vendorUserId", "createdAt");

ALTER TABLE "DirectSaleTransaction" ADD CONSTRAINT "DirectSaleTransaction_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DirectSaleTransaction" ADD CONSTRAINT "DirectSaleTransaction_vendorUserId_fkey" FOREIGN KEY ("vendorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
