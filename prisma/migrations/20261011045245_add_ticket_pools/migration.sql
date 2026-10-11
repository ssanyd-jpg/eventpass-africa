-- CreateTable
CREATE TABLE "TicketPool" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "targetCents" INTEGER NOT NULL,
    "raisedCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'TZS',
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "eventId" TEXT NOT NULL,
    "ticketTypeId" TEXT NOT NULL,
    "creatorUserId" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "resultingOrderId" TEXT,

    CONSTRAINT "TicketPool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PoolContribution" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TZS',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "providerReference" TEXT,
    "providerMessage" TEXT,
    "airpayRef" TEXT,
    "phoneNumber" TEXT,
    "mobileNetwork" TEXT,
    "refundTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "poolId" TEXT NOT NULL,
    "contributorUserId" TEXT NOT NULL,

    CONSTRAINT "PoolContribution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TicketPool_clientId_key" ON "TicketPool"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketPool_resultingOrderId_key" ON "TicketPool"("resultingOrderId");

-- CreateIndex
CREATE INDEX "TicketPool_creatorUserId_idx" ON "TicketPool"("creatorUserId");

-- CreateIndex
CREATE INDEX "TicketPool_recipientUserId_idx" ON "TicketPool"("recipientUserId");

-- CreateIndex
CREATE INDEX "TicketPool_status_expiresAt_idx" ON "TicketPool"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "TicketPool_eventId_idx" ON "TicketPool"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "PoolContribution_clientId_key" ON "PoolContribution"("clientId");

-- CreateIndex
CREATE INDEX "PoolContribution_poolId_status_idx" ON "PoolContribution"("poolId", "status");

-- CreateIndex
CREATE INDEX "PoolContribution_contributorUserId_idx" ON "PoolContribution"("contributorUserId");

-- AddForeignKey
ALTER TABLE "TicketPool" ADD CONSTRAINT "TicketPool_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketPool" ADD CONSTRAINT "TicketPool_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "TicketType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketPool" ADD CONSTRAINT "TicketPool_creatorUserId_fkey" FOREIGN KEY ("creatorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketPool" ADD CONSTRAINT "TicketPool_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketPool" ADD CONSTRAINT "TicketPool_resultingOrderId_fkey" FOREIGN KEY ("resultingOrderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoolContribution" ADD CONSTRAINT "PoolContribution_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "TicketPool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoolContribution" ADD CONSTRAINT "PoolContribution_contributorUserId_fkey" FOREIGN KEY ("contributorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
