-- Session 32 — peer-to-peer ticket resale. Purely additive: two opt-in columns
-- on Event (resale is off by default) and a new TicketListing table.

ALTER TABLE "Event" ADD COLUMN "resaleEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Event" ADD COLUMN "maxResalePrice" INTEGER;

CREATE TABLE "TicketListing" (
    "id" TEXT NOT NULL,
    "askingPrice" INTEGER NOT NULL,
    "originalPrice" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TZS',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "listedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "soldAt" TIMESTAMP(3),
    "commissionAmount" INTEGER NOT NULL DEFAULT 0,
    "sellerPayoutAmount" INTEGER NOT NULL DEFAULT 0,
    "payoutStatus" TEXT NOT NULL DEFAULT 'NONE',
    "reservedByUserId" TEXT,
    "reservedUntil" TIMESTAMP(3),
    "paymentReference" TEXT,
    "ticketId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "buyerId" TEXT,
    "eventId" TEXT NOT NULL,

    CONSTRAINT "TicketListing_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TicketListing_ticketId_key" ON "TicketListing"("ticketId");
CREATE INDEX "TicketListing_eventId_status_idx" ON "TicketListing"("eventId", "status");
CREATE INDEX "TicketListing_sellerId_idx" ON "TicketListing"("sellerId");

ALTER TABLE "TicketListing" ADD CONSTRAINT "TicketListing_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketListing" ADD CONSTRAINT "TicketListing_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TicketListing" ADD CONSTRAINT "TicketListing_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TicketListing" ADD CONSTRAINT "TicketListing_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
