-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "waitlistCutoffHours" INTEGER NOT NULL DEFAULT 24;

-- AlterTable
ALTER TABLE "WaitlistEntry" ADD COLUMN     "convertedAt" TIMESTAMP(3),
ADD COLUMN     "expiredReason" TEXT;
