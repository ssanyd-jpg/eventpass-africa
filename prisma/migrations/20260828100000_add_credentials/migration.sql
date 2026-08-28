-- Credential: audit/history trail for Ticket/Wallet/Vendor code replacement.
-- Purely additive, no backfill needed — absence of rows means "never replaced".

CREATE TABLE "Credential" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL,
    "supersededAt" TIMESTAMP(3),
    "supersededByUserId" TEXT,
    "organizationId" TEXT NOT NULL,
    "ticketId" TEXT,
    "walletId" TEXT,
    "vendorId" TEXT,

    CONSTRAINT "Credential_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Credential_organizationId_ticketId_idx" ON "Credential"("organizationId", "ticketId");
CREATE INDEX "Credential_organizationId_walletId_idx" ON "Credential"("organizationId", "walletId");
CREATE INDEX "Credential_organizationId_vendorId_idx" ON "Credential"("organizationId", "vendorId");

ALTER TABLE "Credential" ADD CONSTRAINT "Credential_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
