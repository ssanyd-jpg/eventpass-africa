-- Sponsor campaigns/coupons: a redeemable code scoped to one sponsor, with
-- a redemption cap. Purely additive: new table, new nullable column on
-- WalletTransaction, one new unique constraint that Postgres's NULL
-- semantics make a no-op for every existing/plain-tap row.

CREATE TABLE "SponsorCampaign" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "maxRedemptions" INTEGER,
    "redemptionCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sponsorId" TEXT NOT NULL,

    CONSTRAINT "SponsorCampaign_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SponsorCampaign_clientId_key" ON "SponsorCampaign"("clientId");
CREATE UNIQUE INDEX "SponsorCampaign_sponsorId_code_key" ON "SponsorCampaign"("sponsorId", "code");

ALTER TABLE "SponsorCampaign" ADD CONSTRAINT "SponsorCampaign_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "Sponsor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WalletTransaction" ADD COLUMN "campaignId" TEXT;
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SponsorCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "WalletTransaction_campaignId_walletId_key" ON "WalletTransaction"("campaignId", "walletId");
