-- Session 8: vendor self-service portal.

-- SALE-only line item, staff-typed at the wallet charge terminal. Nullable
-- so every existing row (and every non-SALE type) is untouched.
ALTER TABLE "WalletTransaction" ADD COLUMN "item" TEXT;

-- Per-vendor sales settlement (owed BY the organizer TO the vendor) —
-- unrelated to Settlement/SettlementItem, which settle the organizer's own
-- ticket-order proceeds out to a mobile money account.
ALTER TABLE "Vendor" ADD COLUMN "settlementStatus" TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "Vendor" ADD COLUMN "settlementAmountCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Vendor" ADD COLUMN "settlementProcessedAt" TIMESTAMP(3);

-- Vendor login has no password — this hashed-token table is the entire
-- mechanism, same shape as PasswordResetToken/OrganizationInvite.
CREATE TABLE "VendorMagicLinkToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vendorId" TEXT NOT NULL,

    CONSTRAINT "VendorMagicLinkToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VendorMagicLinkToken_tokenHash_key" ON "VendorMagicLinkToken"("tokenHash");

ALTER TABLE "VendorMagicLinkToken" ADD CONSTRAINT "VendorMagicLinkToken_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
