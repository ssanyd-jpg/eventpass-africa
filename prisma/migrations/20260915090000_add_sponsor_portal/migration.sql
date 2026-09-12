-- Session 16: sponsor magic-link portal — same shape as VendorMagicLinkToken.
CREATE TABLE "SponsorMagicLinkToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sponsorId" TEXT NOT NULL,

    CONSTRAINT "SponsorMagicLinkToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SponsorMagicLinkToken_tokenHash_key" ON "SponsorMagicLinkToken"("tokenHash");

ALTER TABLE "SponsorMagicLinkToken" ADD CONSTRAINT "SponsorMagicLinkToken_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "Sponsor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
