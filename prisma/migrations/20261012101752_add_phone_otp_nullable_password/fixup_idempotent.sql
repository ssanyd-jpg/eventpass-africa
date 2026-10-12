-- Idempotent re-run of migration.sql in this same folder — safe regardless
-- of which statements already partially applied. Postgres stops a
-- multi-statement script at the first error, so a prior run that hit
-- "PhoneVerificationCode already exists" would never have reached the two
-- CREATE INDEX statements that follow it, including the critical
-- User.phone unique constraint.

ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;

CREATE TABLE IF NOT EXISTS "PhoneVerificationCode" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhoneVerificationCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PhoneVerificationCode_phone_createdAt_idx" ON "PhoneVerificationCode"("phone", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "User_phone_key" ON "User"("phone");
