-- Sponsors: replaces the free-text WalletTransaction.sponsorZoneLabel with a
-- real Sponsor entity the organizer manages (name/tier/fee), same shape as
-- Vendor but organizer-only — no status/ownerUserId/badgeCode/checkedIn.
-- Hand-written expand -> backfill -> contract sequence (same discipline as
-- 20260825140000_add_organizations) since this repoints a live column on a
-- database with real WalletTransaction rows.

-- 1. New table (additive)
CREATE TABLE "Sponsor" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "name" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "contactEmail" TEXT NOT NULL DEFAULT '',
    "contactPhone" TEXT NOT NULL DEFAULT '',
    "feeCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'TZS',
    "feeStatus" TEXT NOT NULL DEFAULT 'NONE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "eventId" TEXT NOT NULL,

    CONSTRAINT "Sponsor_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Sponsor_clientId_key" ON "Sponsor"("clientId");
ALTER TABLE "Sponsor" ADD CONSTRAINT "Sponsor_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Expand: add the new FK column nullable first
ALTER TABLE "WalletTransaction" ADD COLUMN "sponsorId" TEXT;

-- 3. Backfill: one Sponsor per distinct (eventId, sponsorZoneLabel) pair —
-- collapses repeat taps at the same zone onto a single Sponsor row.
INSERT INTO "Sponsor" ("id", "name", "tier", "eventId", "currency", "updatedAt")
SELECT DISTINCT
  'sponsor_' || md5(w."eventId" || ':' || wt."sponsorZoneLabel"),
  wt."sponsorZoneLabel",
  'Other',
  w."eventId",
  e."currency",
  CURRENT_TIMESTAMP
FROM "WalletTransaction" wt
JOIN "Wallet" w ON w."id" = wt."walletId"
JOIN "Event" e ON e."id" = w."eventId"
WHERE wt."type" = 'SPONSOR_TAP' AND wt."sponsorZoneLabel" IS NOT NULL;

UPDATE "WalletTransaction" wt
SET "sponsorId" = 'sponsor_' || md5(w."eventId" || ':' || wt."sponsorZoneLabel")
FROM "Wallet" w
WHERE w."id" = wt."walletId" AND wt."type" = 'SPONSOR_TAP' AND wt."sponsorZoneLabel" IS NOT NULL;

-- 4. Contract: drop the old free-text column and wire the real FK. sponsorId
-- stays nullable — SPONSOR_TAP only, same discipline as vendorId (SALE only).
ALTER TABLE "WalletTransaction" DROP COLUMN "sponsorZoneLabel";
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "Sponsor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
