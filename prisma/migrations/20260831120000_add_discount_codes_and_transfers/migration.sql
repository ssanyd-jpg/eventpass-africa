-- Discount codes (event + ticket-type scoped) and ticket transfers.
-- Purely additive: new nullable/defaulted columns on Order/Ticket, two new
-- tables. No backfill needed — no discount codes or transfers exist today.

-- Order gains discount recording (order-level, snapshot discipline).
ALTER TABLE "Order" ADD COLUMN "discountCodeId" TEXT;
ALTER TABLE "Order" ADD COLUMN "discountCodeText" TEXT;
ALTER TABLE "Order" ADD COLUMN "discountTicketTypeName" TEXT;
ALTER TABLE "Order" ADD COLUMN "discountCents" INTEGER NOT NULL DEFAULT 0;

-- Ticket gains an optional transfer-target holder.
ALTER TABLE "Ticket" ADD COLUMN "currentHolderUserId" TEXT;

CREATE TABLE "DiscountCode" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "code" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "percentOff" INTEGER,
    "amountOffCents" INTEGER,
    "maxRedemptions" INTEGER,
    "redemptionCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "eventId" TEXT NOT NULL,
    "ticketTypeId" TEXT NOT NULL,

    CONSTRAINT "DiscountCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DiscountCode_clientId_key" ON "DiscountCode"("clientId");
CREATE UNIQUE INDEX "DiscountCode_eventId_code_key" ON "DiscountCode"("eventId", "code");

ALTER TABLE "DiscountCode" ADD CONSTRAINT "DiscountCode_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscountCode" ADD CONSTRAINT "DiscountCode_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "TicketType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Order" ADD CONSTRAINT "Order_discountCodeId_fkey" FOREIGN KEY ("discountCodeId") REFERENCES "DiscountCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "TicketTransfer" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ticketId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,

    CONSTRAINT "TicketTransfer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TicketTransfer_tokenHash_key" ON "TicketTransfer"("tokenHash");

ALTER TABLE "TicketTransfer" ADD CONSTRAINT "TicketTransfer_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketTransfer" ADD CONSTRAINT "TicketTransfer_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
