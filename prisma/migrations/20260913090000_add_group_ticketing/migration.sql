-- Session 13: group/family ticketing with a shared wallet.

ALTER TABLE "Wallet" ADD COLUMN "isGroupWallet" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Ticket" ADD COLUMN "ticketGroupId" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "groupMemberName" TEXT;

ALTER TABLE "WalletTransaction" ADD COLUMN "spentByTicketId" TEXT;
ALTER TABLE "WalletTransaction" ADD COLUMN "spentByMemberName" TEXT;

CREATE TABLE "TicketGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventId" TEXT NOT NULL,
    "leadUserId" TEXT NOT NULL,
    "sharedWalletId" TEXT NOT NULL,

    CONSTRAINT "TicketGroup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TicketGroup_sharedWalletId_key" ON "TicketGroup"("sharedWalletId");
CREATE INDEX "TicketGroup_eventId_leadUserId_idx" ON "TicketGroup"("eventId", "leadUserId");

ALTER TABLE "TicketGroup" ADD CONSTRAINT "TicketGroup_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketGroup" ADD CONSTRAINT "TicketGroup_leadUserId_fkey" FOREIGN KEY ("leadUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TicketGroup" ADD CONSTRAINT "TicketGroup_sharedWalletId_fkey" FOREIGN KEY ("sharedWalletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_ticketGroupId_fkey" FOREIGN KEY ("ticketGroupId") REFERENCES "TicketGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
