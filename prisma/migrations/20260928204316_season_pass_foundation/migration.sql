-- DropIndex
DROP INDEX "Wallet_carryOverSourceWalletId_idx";

-- CreateTable
CREATE TABLE "SeasonPass" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TZS',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "maxHolders" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "autoRenewEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoRenewPrice" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "SeasonPass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeasonPassHolder" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "renewalStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "renewalOfferedAt" TIMESTAMP(3),
    "renewalConfirmedAt" TIMESTAMP(3),
    "renewalToken" TEXT,
    "seasonPassId" TEXT NOT NULL,
    "userId" TEXT,
    "credentialId" TEXT,

    CONSTRAINT "SeasonPassHolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeasonPassEvent" (
    "id" TEXT NOT NULL,
    "seasonPassId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,

    CONSTRAINT "SeasonPassEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SeasonPass_organizationId_idx" ON "SeasonPass"("organizationId");

-- CreateIndex
CREATE INDEX "SeasonPass_autoRenewEnabled_endDate_idx" ON "SeasonPass"("autoRenewEnabled", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "SeasonPassHolder_renewalToken_key" ON "SeasonPassHolder"("renewalToken");

-- CreateIndex
CREATE UNIQUE INDEX "SeasonPassHolder_credentialId_key" ON "SeasonPassHolder"("credentialId");

-- CreateIndex
CREATE INDEX "SeasonPassHolder_seasonPassId_idx" ON "SeasonPassHolder"("seasonPassId");

-- CreateIndex
CREATE INDEX "SeasonPassHolder_renewalStatus_idx" ON "SeasonPassHolder"("renewalStatus");

-- CreateIndex
CREATE UNIQUE INDEX "SeasonPassEvent_seasonPassId_eventId_key" ON "SeasonPassEvent"("seasonPassId", "eventId");

-- AddForeignKey
ALTER TABLE "SeasonPass" ADD CONSTRAINT "SeasonPass_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeasonPassHolder" ADD CONSTRAINT "SeasonPassHolder_seasonPassId_fkey" FOREIGN KEY ("seasonPassId") REFERENCES "SeasonPass"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeasonPassEvent" ADD CONSTRAINT "SeasonPassEvent_seasonPassId_fkey" FOREIGN KEY ("seasonPassId") REFERENCES "SeasonPass"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeasonPassEvent" ADD CONSTRAINT "SeasonPassEvent_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
