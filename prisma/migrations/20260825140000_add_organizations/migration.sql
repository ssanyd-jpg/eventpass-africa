-- Organizations: every user belongs to exactly one organization, always.
-- This migration is written by hand (not prisma's auto-diff) as a safe
-- expand -> backfill -> contract sequence, since it repoints Event,
-- MobileMoneyAccount, and Settlement off User and onto a brand new
-- Organization table against a database that already has real rows.

-- 1. New tables (additive, no risk to existing data)
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrganizationMembership" (
    "id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'OWNER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    CONSTRAINT "OrganizationMembership_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OrganizationMembership_userId_key" ON "OrganizationMembership"("userId");
CREATE INDEX "OrganizationMembership_organizationId_idx" ON "OrganizationMembership"("organizationId");
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OrganizationInvite" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'STAFF',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organizationId" TEXT NOT NULL,
    "invitedByUserId" TEXT NOT NULL,
    CONSTRAINT "OrganizationInvite_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OrganizationInvite_tokenHash_key" ON "OrganizationInvite"("tokenHash");
CREATE INDEX "OrganizationInvite_organizationId_idx" ON "OrganizationInvite"("organizationId");
ALTER TABLE "OrganizationInvite" ADD CONSTRAINT "OrganizationInvite_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationInvite" ADD CONSTRAINT "OrganizationInvite_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. Expand: add the new FK column nullable first, so this ships with zero
-- risk to the existing organizerId-based reads/writes still in the old code.
ALTER TABLE "Event" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "MobileMoneyAccount" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "Settlement" ADD COLUMN "organizationId" TEXT;

-- 3. Backfill: one personal Organization + OWNER membership for every
-- existing User (not just ones who currently own events) — this is the
-- "every user has exactly one org, always" invariant applied retroactively.
INSERT INTO "Organization" ("id", "name", "createdAt", "updatedAt")
SELECT 'org_' || u."id", u."name" || '''s Organization', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "User" u;

INSERT INTO "OrganizationMembership" ("id", "role", "createdAt", "userId", "organizationId")
SELECT 'mem_' || u."id", 'OWNER', CURRENT_TIMESTAMP, u."id", 'org_' || u."id"
FROM "User" u;

UPDATE "Event" SET "organizationId" = 'org_' || "organizerId" WHERE "organizationId" IS NULL;
UPDATE "MobileMoneyAccount" SET "organizationId" = 'org_' || "organizerId" WHERE "organizationId" IS NULL;
UPDATE "Settlement" SET "organizationId" = 'org_' || "organizerId" WHERE "organizationId" IS NULL;

-- 4. Contract: now that every row is backfilled, enforce NOT NULL and drop
-- the old User-pointing columns/constraints in the same migration (this repo
-- has no separate production deploy window between "migrate" and "app code
-- ships" — both land in the same commit — so there's no benefit to spreading
-- this across multiple migration files/deploys).
ALTER TABLE "Event" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "MobileMoneyAccount" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Settlement" ALTER COLUMN "organizationId" SET NOT NULL;

ALTER TABLE "Event" DROP CONSTRAINT "Event_organizerId_fkey";
ALTER TABLE "Event" DROP COLUMN "organizerId";
ALTER TABLE "MobileMoneyAccount" DROP CONSTRAINT "MobileMoneyAccount_organizerId_fkey";
ALTER TABLE "MobileMoneyAccount" DROP COLUMN "organizerId";
ALTER TABLE "Settlement" DROP CONSTRAINT "Settlement_organizerId_fkey";
ALTER TABLE "Settlement" DROP COLUMN "organizerId";

ALTER TABLE "Event" ADD CONSTRAINT "Event_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MobileMoneyAccount" ADD CONSTRAINT "MobileMoneyAccount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
