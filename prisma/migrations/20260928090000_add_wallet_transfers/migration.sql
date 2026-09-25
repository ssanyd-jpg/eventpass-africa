-- Session 37 — peer-to-peer wallet transfers between wristband holders at the
-- same event. Purely additive: one Boolean column with a default on Event and
-- one new table. Existing rows and code paths are untouched.

ALTER TABLE "Event" ADD COLUMN "transferEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "WalletTransfer" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "method" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "amountCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'TZS',
    "transferCode" TEXT,
    "senderTransactionId" TEXT,
    "recipientTransactionId" TEXT,
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "senderWalletId" TEXT,
    "recipientWalletId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,

    CONSTRAINT "WalletTransfer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WalletTransfer_clientId_key" ON "WalletTransfer"("clientId");
CREATE INDEX "WalletTransfer_eventId_status_idx" ON "WalletTransfer"("eventId", "status");
CREATE INDEX "WalletTransfer_transferCode_status_idx" ON "WalletTransfer"("transferCode", "status");
CREATE INDEX "WalletTransfer_status_expiresAt_idx" ON "WalletTransfer"("status", "expiresAt");
CREATE INDEX "WalletTransfer_senderWalletId_idx" ON "WalletTransfer"("senderWalletId");
CREATE INDEX "WalletTransfer_recipientWalletId_idx" ON "WalletTransfer"("recipientWalletId");

ALTER TABLE "WalletTransfer" ADD CONSTRAINT "WalletTransfer_senderWalletId_fkey" FOREIGN KEY ("senderWalletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WalletTransfer" ADD CONSTRAINT "WalletTransfer_recipientWalletId_fkey" FOREIGN KEY ("recipientWalletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WalletTransfer" ADD CONSTRAINT "WalletTransfer_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
